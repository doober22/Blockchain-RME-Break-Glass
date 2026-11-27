import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  EmergencyContextError,
  evaluateEmergencyContext,
  parseNonzeroAddress,
  parseNonzeroBytes32,
  type EmergencyEvaluationReason,
  type OnChainEmergencyRequest,
} from "./emergency-context.ts";
import { fetchEmergencyContext } from "./mock-api.ts";

export const oracleControllerAbi = parseAbi([
  "function registry() view returns (address)",
  "function getRequest(uint256 requestId) view returns ((bool exists,address patient,address clinician,bytes32 requesterFacilityId,bytes32 encounterId,uint16 reasonCode,bytes32 evidenceCommitment,bytes32 requestHash,uint64 requestedDuration,uint64 createdAt,uint64 decisionDeadline,uint64 activatedAt,uint64 expiresAt,uint8 status,bytes32 attestationHash))",
  "function getRequestRecords(uint256 requestId) view returns (bytes32[])",
  "function resolveEmergency(uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil)",
  "event EmergencyRequested(uint256 indexed requestId, address indexed patient, address indexed clinician, bytes32 facilityId, bytes32 requestHash, uint64 deadline)",
  "event EmergencyResolved(uint256 indexed requestId, bool approved, address indexed oracle, bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt)",
]);

const oracleRegistryAbi = parseAbi([
  "function ORACLE_ROLE() view returns (bytes32)",
  "function isEligible(address account, bytes32 role) view returns (bool)",
  "function getParticipant(address account) view returns ((bool exists,bytes32 facilityId,bool active,uint64 validUntil))",
]);

export const DEFAULT_ORACLE_TIMEOUT_MS = 3_000;
export const DEFAULT_ORACLE_MAX_ATTEMPTS = 3;
export const DEFAULT_ORACLE_BACKOFF_MS: readonly number[] = [1_000, 2_000];

export type OracleDecisionOutcome = "approved" | "rejected" | "abstained" | "already_resolved" | "expired";

export interface OracleDecisionRecord {
  requestId: string;
  eventKey: string;
  facilityId: Hex;
  encounterId?: Hex;
  outcome: OracleDecisionOutcome;
  attempts: number;
  transactionHash?: Hex;
  attestationHash?: Hex;
  reason?: string;
  time: string;
}

export interface OracleCheckpoint {
  schemaVersion: 1;
  chainId: 1337;
  genesisHash: Hex;
  controller: Address;
  oracle: Address;
  facilityId: Hex;
  lastProcessedBlock: string;
  processedRequests: Record<
    string,
    {
      eventKey: string;
      outcome: OracleDecisionOutcome;
      attempts: number;
      transactionHash?: Hex;
      attestationHash?: Hex;
      reason?: string;
      updatedAt: string;
    }
  >;
}

export function oracleClients(rpcUrl: string, customTransport?: Transport) {
  const chain = defineChain({
    id: 1337,
    name: "RME Besu",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = customTransport ?? http(rpcUrl, { timeout: 4_000, retryCount: 0 });
  const reader = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 500 });
  return {
    reader,
    wallet: (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport }),
  };
}

export async function connectOracle(config: {
  rpcUrl: string;
  account: PrivateKeyAccount;
  controller: Address;
  registry: Address;
  genesisHash?: Hex;
  transport?: Transport;
}) {
  const controllerAddress = parseNonzeroAddress(config.controller, "controller");
  const registryAddress = parseNonzeroAddress(config.registry, "registry");
  const { reader, wallet } = oracleClients(config.rpcUrl, config.transport);
  const writer = wallet(config.account);
  const controller = { abi: oracleControllerAbi, address: controllerAddress };
  const registry = { abi: oracleRegistryAbi, address: registryAddress };

  const actualChain = await reader.getChainId();
  const genesis = await reader.getBlock({ blockNumber: 0n });
  if (!genesis.hash) {
    throw new Error("Missing genesis block hash on chain 1337");
  }
  const expectedGenesis =
    config.genesisHash !== undefined ? parseNonzeroBytes32(config.genesisHash, "genesisHash") : (genesis.hash.toLowerCase() as Hex);
  const wiredRegistry = await reader.readContract({ ...controller, functionName: "registry" });
  if (
    actualChain !== 1337 ||
    genesis.hash.toLowerCase() !== expectedGenesis ||
    getAddress(wiredRegistry) !== registryAddress
  ) {
    throw new Error("Oracle deployment does not match the configured chain");
  }

  const oracleRole = await reader.readContract({ ...registry, functionName: "ORACLE_ROLE" });
  const [eligible, participant] = await Promise.all([
    reader.readContract({ ...registry, functionName: "isEligible", args: [config.account.address, oracleRole] }),
    reader.readContract({ ...registry, functionName: "getParticipant", args: [config.account.address] }),
  ]);
  if (!eligible || !participant.exists || !participant.active) {
    throw new Error("Oracle account is not currently eligible in ParticipantRegistry");
  }
  const facilityId = parseNonzeroBytes32(participant.facilityId, "oracle.facilityId");

  return {
    reader,
    writer,
    oracleAddress: getAddress(config.account.address),
    controllerAddress,
    registryAddress,
    genesisHash: genesis.hash.toLowerCase() as Hex,
    facilityId,
    oracleRole,
    async isOracleEligible(blockNumber?: bigint): Promise<boolean> {
      const at = blockNumber !== undefined ? { blockNumber } : {};
      const [currentlyEligible, currentParticipant] = await Promise.all([
        reader.readContract({ ...registry, ...at, functionName: "isEligible", args: [config.account.address, oracleRole] }),
        reader.readContract({ ...registry, ...at, functionName: "getParticipant", args: [config.account.address] }),
      ]);
      return currentlyEligible && currentParticipant.exists && currentParticipant.active &&
        currentParticipant.facilityId.toLowerCase() === facilityId;
    },
    async readRequest(requestId: bigint): Promise<{
      exists: boolean;
      request: OnChainEmergencyRequest;
      headTimestamp: bigint;
      headNumber: bigint;
    }> {
      const head = await reader.getBlock({ blockTag: "latest" });
      const raw = await reader.readContract({
        ...controller,
        blockNumber: head.number,
        functionName: "getRequest",
        args: [requestId],
      });
      if (!raw.exists) {
        return {
          exists: false,
          headTimestamp: head.timestamp,
          headNumber: head.number,
          request: {
            exists: false,
            requestId,
            patient: raw.patient,
            clinician: raw.clinician,
            requesterFacilityId: raw.requesterFacilityId,
            encounterId: raw.encounterId,
            recordIds: [],
            reasonCode: Number(raw.reasonCode),
            evidenceCommitment: raw.evidenceCommitment,
            requestedDuration: raw.requestedDuration,
            decisionDeadline: raw.decisionDeadline,
            requestHash: raw.requestHash,
            status: Number(raw.status),
          },
        };
      }
      const recordIds = await reader.readContract({
        ...controller,
        blockNumber: head.number,
        functionName: "getRequestRecords",
        args: [requestId],
      });
      return {
        exists: true,
        headTimestamp: head.timestamp,
        headNumber: head.number,
        request: {
          exists: true,
          requestId,
          patient: getAddress(raw.patient),
          clinician: getAddress(raw.clinician),
          requesterFacilityId: raw.requesterFacilityId.toLowerCase() as Hex,
          encounterId: raw.encounterId.toLowerCase() as Hex,
          recordIds: recordIds.map((id) => id.toLowerCase() as Hex),
          reasonCode: Number(raw.reasonCode),
          evidenceCommitment: raw.evidenceCommitment.toLowerCase() as Hex,
          requestedDuration: raw.requestedDuration,
          decisionDeadline: raw.decisionDeadline,
          requestHash: raw.requestHash.toLowerCase() as Hex,
          status: Number(raw.status),
        },
      };
    },
    async resolveAndConfirm(input: {
      requestId: bigint;
      approved: boolean;
      requestHash: Hex;
      observedAt: bigint;
      validUntil: bigint;
      expectedAttestationHash: Hex;
      requestedDuration: bigint;
    }): Promise<Hex> {
      const txHash = await writer.writeContract({
        ...controller,
        functionName: "resolveEmergency",
        args: [input.requestId, input.approved, input.requestHash, input.observedAt, input.validUntil],
      });
      const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 15_000, retryCount: 0 });
      const committedBlock = await reader.getBlock({ blockNumber: receipt.blockNumber });
      if (
        receipt.status !== "success" ||
        receipt.transactionHash !== txHash ||
        committedBlock.hash !== receipt.blockHash
      ) {
        throw new Error("Missing successful committed QBFT resolution receipt");
      }
      const matchingLogs = receipt.logs.filter((log) => {
        if (getAddress(log.address) !== controllerAddress) return false;
        try {
          const { args } = decodeEventLog({
            abi: oracleControllerAbi,
            eventName: "EmergencyResolved",
            data: log.data,
            topics: log.topics,
          });
          const expectedActivatedAt = input.approved ? committedBlock.timestamp : 0n;
          const expectedExpiresAt = input.approved ? committedBlock.timestamp + input.requestedDuration : 0n;
          return (
            args.requestId === input.requestId &&
            args.approved === input.approved &&
            getAddress(args.oracle) === getAddress(config.account.address) &&
            args.attestationHash.toLowerCase() === input.expectedAttestationHash.toLowerCase() &&
            args.activatedAt === expectedActivatedAt &&
            args.expiresAt === expectedExpiresAt
          );
        } catch {
          return false;
        }
      });
      if (matchingLogs.length !== 1) {
        throw new Error("Missing matching EmergencyResolved event in receipt");
      }
      return txHash;
    },
  };
}

function isRetriableError(error: unknown): boolean {
  return (
    error instanceof EmergencyContextError &&
    (error.code === "api_unreachable" || error.code === "api_http_error")
  );
}

export function createOracleWorker(config: {
  chain: Awaited<ReturnType<typeof connectOracle>>;
  apiBaseUrl: string;
  serviceToken: string;
  checkpointPath: string;
  auditPath: string;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}) {
  const maxAttempts = config.maxAttempts ?? DEFAULT_ORACLE_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error("Expected maxAttempts between 1 and 5");
  }
  const backoffMs = config.backoffMs ?? DEFAULT_ORACLE_BACKOFF_MS;
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
  const sleep = config.sleep ?? ((ms: number) => delay(ms));

  function initialCheckpoint(): OracleCheckpoint {
    return {
      schemaVersion: 1,
      chainId: 1337,
      genesisHash: config.chain.genesisHash,
      controller: config.chain.controllerAddress,
      oracle: config.chain.oracleAddress,
      facilityId: config.chain.facilityId,
      lastProcessedBlock: "-1",
      processedRequests: {},
    };
  }

  async function loadCheckpoint(): Promise<OracleCheckpoint> {
    let rawText: string;
    try {
      rawText = await readFile(config.checkpointPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return initialCheckpoint();
      }
      throw error;
    }
    const parsed = JSON.parse(rawText) as Partial<OracleCheckpoint>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.chainId !== 1337 ||
      typeof parsed.genesisHash !== "string" ||
      parsed.genesisHash.toLowerCase() !== config.chain.genesisHash ||
      typeof parsed.controller !== "string" ||
      getAddress(parsed.controller) !== config.chain.controllerAddress ||
      typeof parsed.oracle !== "string" ||
      getAddress(parsed.oracle) !== config.chain.oracleAddress ||
      typeof parsed.facilityId !== "string" ||
      parsed.facilityId.toLowerCase() !== config.chain.facilityId ||
      typeof parsed.lastProcessedBlock !== "string" ||
      !/^-?\d+$/.test(parsed.lastProcessedBlock) ||
      typeof parsed.processedRequests !== "object" ||
      parsed.processedRequests === null ||
      Array.isArray(parsed.processedRequests)
    ) {
      throw new Error("Oracle checkpoint does not match the current chain, controller, or oracle identity");
    }
    return parsed as OracleCheckpoint;
  }

  async function saveCheckpoint(checkpoint: OracleCheckpoint): Promise<void> {
    await mkdir(dirname(config.checkpointPath), { recursive: true, mode: 0o700 });
    const tempPath = `${config.checkpointPath}.tmp`;
    await writeFile(tempPath, JSON.stringify(checkpoint, null, 2) + "\n", { mode: 0o600 });
    await rename(tempPath, config.checkpointPath);
  }

  async function appendAudit(entry: OracleDecisionRecord): Promise<void> {
    await mkdir(dirname(config.auditPath), { recursive: true, mode: 0o700 });
    await appendFile(config.auditPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  async function handleRequest(
    checkpoint: OracleCheckpoint,
    requestId: bigint,
    eventKey: string,
  ): Promise<OracleDecisionRecord> {
    const key = requestId.toString();
    const existing = checkpoint.processedRequests[key];
    if (existing) {
      return {
        requestId: key,
        eventKey: existing.eventKey,
        facilityId: config.chain.facilityId,
        outcome: existing.outcome,
        attempts: existing.attempts,
        transactionHash: existing.transactionHash,
        attestationHash: existing.attestationHash,
        reason: existing.reason,
        time: existing.updatedAt,
      };
    }

    const { exists, request, headTimestamp, headNumber } = await config.chain.readRequest(requestId);
    if (!exists) {
      throw new Error(`Request ${key} does not exist on-chain`);
    }
    if (request.requesterFacilityId !== config.chain.facilityId) {
      throw new Error(`Request ${key} belongs to a different facility`);
    }

    async function recordOutcome(
      outcome: OracleDecisionOutcome,
      attempts: number,
      extra: { transactionHash?: Hex; attestationHash?: Hex; reason?: string } = {},
    ): Promise<OracleDecisionRecord> {
      const nowIso = new Date().toISOString();
      const entry: OracleDecisionRecord = {
        requestId: key,
        eventKey,
        facilityId: config.chain.facilityId,
        encounterId: request.encounterId,
        outcome,
        attempts,
        ...(extra.transactionHash ? { transactionHash: extra.transactionHash } : {}),
        ...(extra.attestationHash ? { attestationHash: extra.attestationHash } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
        time: nowIso,
      };
      checkpoint.processedRequests[key] = {
        eventKey,
        outcome,
        attempts,
        ...(extra.transactionHash ? { transactionHash: extra.transactionHash } : {}),
        ...(extra.attestationHash ? { attestationHash: extra.attestationHash } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
        updatedAt: nowIso,
      };
      await saveCheckpoint(checkpoint);
      await appendAudit(entry);
      return entry;
    }

    // Recheck on-chain state first for crash recovery and idempotency.
    if (request.status !== 0) {
      return recordOutcome("already_resolved", 0);
    }
    if (headTimestamp >= request.decisionDeadline) {
      return recordOutcome("expired", 0, { reason: "request_deadline_passed" });
    }
    if (!(await config.chain.isOracleEligible(headNumber))) {
      return recordOutcome("abstained", 0, { reason: "oracle_ineligible" });
    }

    let attempts = 0;
    let lastReason: EmergencyEvaluationReason = "api_unreachable";

    while (attempts < maxAttempts) {
      const current = await config.chain.readRequest(requestId);
      if (current.request.status !== 0) {
        return recordOutcome("already_resolved", attempts);
      }
      if (current.headTimestamp >= current.request.decisionDeadline) {
        return recordOutcome("expired", attempts, { reason: "request_deadline_passed" });
      }

      attempts += 1;
      try {
        const remainingSeconds = current.request.decisionDeadline - current.headTimestamp;
        const effectiveTimeoutMs = Math.min(
          requestTimeoutMs,
          Math.max(250, Number(remainingSeconds) * 1_000),
        );
        const context = await fetchEmergencyContext({
          baseUrl: config.apiBaseUrl,
          encounterId: current.request.encounterId,
          serviceToken: config.serviceToken,
          expectedFacilityId: config.chain.facilityId,
          timeoutMs: effectiveTimeoutMs,
          fetchImpl: config.fetchImpl,
        });

        const freshState = await config.chain.readRequest(requestId);
        if (freshState.request.status !== 0) {
          return recordOutcome("already_resolved", attempts);
        }
        if (freshState.headTimestamp >= freshState.request.decisionDeadline) {
          return recordOutcome("expired", attempts, { reason: "request_deadline_passed" });
        }

        const evaluation = evaluateEmergencyContext({
          chainId: 1337n,
          controller: config.chain.controllerAddress,
          request: freshState.request,
          context,
          now: freshState.headTimestamp,
        });

        if (evaluation.action === "abstain") {
          return recordOutcome("abstained", attempts, { reason: evaluation.reason });
        }

        const txHash = await config.chain.resolveAndConfirm({
          requestId,
          approved: evaluation.approved,
          requestHash: evaluation.requestHash,
          observedAt: evaluation.observedAt,
          validUntil: evaluation.validUntil,
          expectedAttestationHash: evaluation.attestationHash,
          requestedDuration: freshState.request.requestedDuration,
        });

        return recordOutcome(evaluation.approved ? "approved" : "rejected", attempts, {
          transactionHash: txHash,
          attestationHash: evaluation.attestationHash,
        });
      } catch (error) {
        if (error instanceof EmergencyContextError) {
          lastReason = error.code;
        }
        if (!isRetriableError(error) || attempts >= maxAttempts) {
          break;
        }
        const waitMs = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)] ?? 1_000;
        const afterFailure = await config.chain.readRequest(requestId);
        if (afterFailure.request.status !== 0) {
          return recordOutcome("already_resolved", attempts);
        }
        const remainingMs = Number(afterFailure.request.decisionDeadline - afterFailure.headTimestamp) * 1_000;
        if (remainingMs <= waitMs) {
          lastReason = "request_deadline_passed";
          break;
        }
        await sleep(waitMs);
      }
    }

    return recordOutcome("abstained", attempts, { reason: lastReason });
  }

  return {
    loadCheckpoint,
    async processRequest(requestId: bigint, eventKey = `manual:${requestId.toString()}`): Promise<OracleDecisionRecord> {
      const checkpoint = await loadCheckpoint();
      return handleRequest(checkpoint, requestId, eventKey);
    },
    async syncOnce(): Promise<{
      fromBlock: bigint;
      toBlock: bigint;
      decisions: OracleDecisionRecord[];
    }> {
      const checkpoint = await loadCheckpoint();
      const latestBlock = await config.chain.reader.getBlock({ blockTag: "latest" });
      const lastBlock = BigInt(checkpoint.lastProcessedBlock);
      const fromBlock = lastBlock + 1n;
      const toBlock = latestBlock.number;
      if (fromBlock > toBlock) {
        return { fromBlock, toBlock, decisions: [] };
      }

      const logs = await config.chain.reader.getLogs({
        address: config.chain.controllerAddress,
        event: oracleControllerAbi[4],
        fromBlock,
        toBlock,
        strict: true,
      });

      const decisions: OracleDecisionRecord[] = [];
      for (const log of logs) {
        if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) {
          continue;
        }
        const block = await config.chain.reader.getBlock({ blockNumber: log.blockNumber });
        if (block.hash !== log.blockHash) {
          throw new Error("Committed block hash mismatch while scanning EmergencyRequested logs");
        }
        if (log.args.facilityId.toLowerCase() !== config.chain.facilityId) {
          continue;
        }
        const eventKey = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
        const decision = await handleRequest(checkpoint, log.args.requestId, eventKey);
        decisions.push(decision);
      }

      checkpoint.lastProcessedBlock = toBlock.toString();
      await saveCheckpoint(checkpoint);
      return { fromBlock, toBlock, decisions };
    },
  };
}
