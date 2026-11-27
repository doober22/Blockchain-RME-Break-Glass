import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashEmergencyAttestation } from "../smart-contract/integration/attestation-hash.ts";
import { hashEmergencyRequest } from "../smart-contract/integration/request-hash.ts";
import { hashClinicalEvidence } from "./emergency-context.ts";
import { createMockFacilityApi, type SyntheticClinicalAssessment } from "./mock-api.ts";
import {
  connectOracle,
  createOracleWorker,
  oracleControllerAbi,
  type OracleDecisionRecord,
} from "./worker.ts";

const bytes32 = (value: number): Hex => toHex(value, { size: 32 });
const ORACLE_ROLE = keccak256(toHex("ORACLE_ROLE"));

const combinedAbi = [
  ...oracleControllerAbi,
  {
    type: "function",
    name: "ORACLE_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isEligible",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "role", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getParticipant",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "exists", type: "bool" },
          { name: "facilityId", type: "bytes32" },
          { name: "active", type: "bool" },
          { name: "validUntil", type: "uint64" },
        ],
      },
    ],
  },
] as const;

interface SimulatedRequest {
  exists: boolean;
  requestId: bigint;
  patient: Address;
  clinician: Address;
  requesterFacilityId: Hex;
  encounterId: Hex;
  recordIds: Hex[];
  reasonCode: number;
  evidenceCommitment: Hex;
  requestHash: Hex;
  requestedDuration: bigint;
  createdAt: bigint;
  decisionDeadline: bigint;
  activatedAt: bigint;
  expiresAt: bigint;
  status: number;
  attestationHash: Hex;
}

function createSimulatedBesuChain(config: {
  controller: Address;
  registry: Address;
  oracleAddress: Address;
  oracleFacilityId: Hex;
  initialTimestamp: bigint;
}) {
  let blockNumber = 0n;
  let timestamp = config.initialTimestamp;
  let oracleEligible = true;
  const genesisHash = keccak256(toHex("simulated-besu-genesis-1337"));
  const blocks = new Map<bigint, { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }>();
  blocks.set(0n, { number: 0n, hash: genesisHash, parentHash: bytes32(0), timestamp });

  const requests = new Map<bigint, SimulatedRequest>();
  const logs: Array<{
    address: Address;
    blockNumber: bigint;
    blockHash: Hex;
    transactionHash: Hex;
    transactionIndex: number;
    logIndex: number;
    data: Hex;
    topics: Hex[];
  }> = [];
  const receipts = new Map<Hex, object>();
  const nonces = new Map<Address, number>();
  let nextRequestId = 0n;

  function mineBlock(advanceSeconds = 1n) {
    const parent = blocks.get(blockNumber)!;
    blockNumber += 1n;
    timestamp += advanceSeconds;
    const hash = keccak256(toHex(`block:${blockNumber}:${timestamp}:${parent.hash}`));
    const block = { number: blockNumber, hash, parentHash: parent.hash, timestamp };
    blocks.set(blockNumber, block);
    return block;
  }

  function createEmergencyRequest(input: {
    patient: Address;
    clinician: Address;
    requesterFacilityId: Hex;
    encounterId: Hex;
    recordIds: Hex[];
    reasonCode: number;
    evidenceCommitment: Hex;
    requestedDuration: bigint;
  }): SimulatedRequest {
    const block = mineBlock(1n);
    nextRequestId += 1n;
    const requestId = nextRequestId;
    const createdAt = block.timestamp;
    const decisionDeadline = createdAt + 120n;
    const requestHash = hashEmergencyRequest({
      chainId: 1337n,
      controller: config.controller,
      requestId,
      patient: input.patient,
      clinician: input.clinician,
      requesterFacilityId: input.requesterFacilityId,
      encounterId: input.encounterId,
      recordIds: input.recordIds,
      reasonCode: input.reasonCode,
      evidenceCommitment: input.evidenceCommitment,
      requestedDuration: input.requestedDuration,
      decisionDeadline,
    });
    const req: SimulatedRequest = {
      exists: true,
      requestId,
      patient: getAddress(input.patient),
      clinician: getAddress(input.clinician),
      requesterFacilityId: input.requesterFacilityId.toLowerCase() as Hex,
      encounterId: input.encounterId.toLowerCase() as Hex,
      recordIds: input.recordIds.map((id) => id.toLowerCase() as Hex),
      reasonCode: input.reasonCode,
      evidenceCommitment: input.evidenceCommitment.toLowerCase() as Hex,
      requestHash,
      requestedDuration: input.requestedDuration,
      createdAt,
      decisionDeadline,
      activatedAt: 0n,
      expiresAt: 0n,
      status: 0,
      attestationHash: bytes32(0),
    };
    requests.set(requestId, req);

    const topics = encodeEventTopics({
      abi: oracleControllerAbi,
      eventName: "EmergencyRequested",
      args: {
        requestId,
        patient: req.patient,
        clinician: req.clinician,
      },
    }) as Hex[];
    const data = encodeAbiParameters(
      parseAbiParameters("bytes32 facilityId, bytes32 requestHash, uint64 deadline"),
      [req.requesterFacilityId, req.requestHash, req.decisionDeadline],
    );
    const txHash = keccak256(toHex(`request-tx:${requestId}`));
    logs.push({
      address: config.controller,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      data,
      topics,
    });
    return req;
  }

  function applyResolution(
    sender: Address,
    requestId: bigint,
    approved: boolean,
    requestHash: Hex,
    observedAt: bigint,
    validUntil: bigint,
    txHash: Hex,
  ) {
    const req = requests.get(requestId);
    if (!req || !req.exists) throw new Error("RequestNotFound");
    if (!oracleEligible || getAddress(sender) !== getAddress(config.oracleAddress)) {
      throw new Error("IneligibleOracle");
    }
    if (req.requesterFacilityId !== config.oracleFacilityId.toLowerCase()) {
      throw new Error("WrongFacility");
    }
    if (req.status !== 0) throw new Error("RequestNotPending");
    const block = mineBlock(1n);
    if (block.timestamp >= req.decisionDeadline) throw new Error("RequestDeadlinePassed");
    if (requestHash.toLowerCase() !== req.requestHash.toLowerCase()) throw new Error("RequestHashMismatch");
    if (
      observedAt > block.timestamp ||
      validUntil <= observedAt ||
      block.timestamp >= validUntil ||
      block.timestamp - observedAt > 60n ||
      validUntil - observedAt > 60n
    ) {
      throw new Error("InvalidAttestationTimestamps");
    }

    if (approved) {
      req.activatedAt = block.timestamp;
      req.expiresAt = block.timestamp + req.requestedDuration;
      req.status = 2; // ACTIVE
    } else {
      req.activatedAt = 0n;
      req.expiresAt = 0n;
      req.status = 1; // REJECTED
    }
    req.attestationHash = hashEmergencyAttestation({
      chainId: 1337n,
      controller: config.controller,
      requestId,
      requestHash: req.requestHash,
      approved,
      observedAt,
      validUntil,
    });

    const topics = encodeEventTopics({
      abi: oracleControllerAbi,
      eventName: "EmergencyResolved",
      args: {
        requestId,
        oracle: getAddress(sender),
      },
    }) as Hex[];
    const data = encodeAbiParameters(
      parseAbiParameters("bool approved, bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt"),
      [approved, req.attestationHash, req.activatedAt, req.expiresAt],
    );
    const resolvedLog = {
      address: config.controller,
      blockNumber: toHex(block.number),
      blockHash: block.hash,
      transactionHash: txHash,
      transactionIndex: "0x0",
      logIndex: "0x0",
      data,
      topics,
      removed: false,
    };
    receipts.set(txHash, {
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash: block.hash,
      blockNumber: toHex(block.number),
      from: getAddress(sender),
      to: config.controller,
      cumulativeGasUsed: toHex(150_000n),
      gasUsed: toHex(150_000n),
      contractAddress: null,
      logs: [resolvedLog],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      effectiveGasPrice: toHex(1_000_000_000n),
      type: "0x2",
    });
  }

  function formatBlock(b: { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }) {
    return {
      number: toHex(b.number),
      hash: b.hash,
      parentHash: b.parentHash,
      nonce: "0x0000000000000000",
      sha3Uncles: bytes32(0),
      logsBloom: `0x${"00".repeat(256)}`,
      transactionsRoot: bytes32(0),
      stateRoot: bytes32(0),
      receiptsRoot: bytes32(0),
      miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x200",
      gasLimit: toHex(30_000_000n),
      gasUsed: "0x0",
      timestamp: toHex(b.timestamp),
      transactions: [],
      uncles: [],
      baseFeePerGas: toHex(1_000_000_000n),
    };
  }

  const transport = custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return "0x539";
      if (method === "eth_blockNumber") return toHex(blockNumber);
      if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas") return toHex(1_000_000_000n);
      if (method === "eth_estimateGas") return toHex(250_000n);
      if (method === "eth_getTransactionCount") {
        const [addr] = params as [Address];
        return toHex(nonces.get(getAddress(addr)) ?? 0);
      }
      if (method === "eth_getBlockByNumber") {
        const [tag] = params as [string];
        const target = tag === "latest" || tag === "pending" ? blockNumber : BigInt(tag);
        const found = blocks.get(target);
        return found ? formatBlock(found) : null;
      }
      if (method === "eth_getLogs") {
        const [filter] = params as [{ fromBlock?: string; toBlock?: string; address?: Address }];
        const from = filter.fromBlock ? BigInt(filter.fromBlock) : 0n;
        const to = !filter.toBlock || filter.toBlock === "latest" ? blockNumber : BigInt(filter.toBlock);
        return logs
          .filter((log) => log.blockNumber >= from && log.blockNumber <= to)
          .map((log) => ({
            address: log.address,
            blockNumber: toHex(log.blockNumber),
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            transactionIndex: toHex(log.transactionIndex),
            logIndex: toHex(log.logIndex),
            data: log.data,
            topics: log.topics,
            removed: false,
          }));
      }
      if (method === "eth_call") {
        const [call] = params as [{ to: Address; data: Hex }];
        const decoded = decodeFunctionData({ abi: combinedAbi, data: call.data });
        if (decoded.functionName === "registry") {
          return encodeFunctionResult({ abi: combinedAbi, functionName: "registry", result: config.registry });
        }
        if (decoded.functionName === "ORACLE_ROLE") {
          return encodeFunctionResult({ abi: combinedAbi, functionName: "ORACLE_ROLE", result: ORACLE_ROLE });
        }
        if (decoded.functionName === "isEligible") {
          const [account, role] = decoded.args as [Address, Hex];
          const ok =
            oracleEligible &&
            getAddress(account) === getAddress(config.oracleAddress) &&
            role.toLowerCase() === ORACLE_ROLE.toLowerCase();
          return encodeFunctionResult({ abi: combinedAbi, functionName: "isEligible", result: ok });
        }
        if (decoded.functionName === "getParticipant") {
          const [account] = decoded.args as [Address];
          const isOracle = getAddress(account) === getAddress(config.oracleAddress);
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getParticipant",
            result: {
              exists: isOracle,
              facilityId: isOracle ? config.oracleFacilityId : bytes32(0),
              active: isOracle && oracleEligible,
              validUntil: timestamp + 10_000n,
            },
          });
        }
        if (decoded.functionName === "getRequest") {
          const [id] = decoded.args as [bigint];
          const req = requests.get(id);
          if (!req) {
            return encodeFunctionResult({
              abi: combinedAbi,
              functionName: "getRequest",
              result: {
                exists: false,
                patient: "0x0000000000000000000000000000000000000000",
                clinician: "0x0000000000000000000000000000000000000000",
                requesterFacilityId: bytes32(0),
                encounterId: bytes32(0),
                reasonCode: 0,
                evidenceCommitment: bytes32(0),
                requestHash: bytes32(0),
                requestedDuration: 0n,
                createdAt: 0n,
                decisionDeadline: 0n,
                activatedAt: 0n,
                expiresAt: 0n,
                status: 0,
                attestationHash: bytes32(0),
              },
            });
          }
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getRequest",
            result: {
              exists: req.exists,
              patient: req.patient,
              clinician: req.clinician,
              requesterFacilityId: req.requesterFacilityId,
              encounterId: req.encounterId,
              reasonCode: req.reasonCode,
              evidenceCommitment: req.evidenceCommitment,
              requestHash: req.requestHash,
              requestedDuration: req.requestedDuration,
              createdAt: req.createdAt,
              decisionDeadline: req.decisionDeadline,
              activatedAt: req.activatedAt,
              expiresAt: req.expiresAt,
              status: req.status,
              attestationHash: req.attestationHash,
            },
          });
        }
        if (decoded.functionName === "getRequestRecords") {
          const [id] = decoded.args as [bigint];
          const req = requests.get(id);
          if (!req) throw new Error("RequestNotFound");
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getRequestRecords",
            result: req.recordIds,
          });
        }
      }
      if (method === "eth_sendRawTransaction") {
        const [rawTx] = params as [TransactionSerialized];
        const sender = await recoverTransactionAddress({ serializedTransaction: rawTx });
        const parsed = parseTransaction(rawTx);
        const decoded = decodeFunctionData({ abi: oracleControllerAbi, data: parsed.data! });
        if (decoded.functionName !== "resolveEmergency") {
          throw new Error(`Unsupported transaction method: ${decoded.functionName}`);
        }
        const [requestId, approved, requestHash, observedAt, validUntil] = decoded.args;
        const txHash = keccak256(rawTx);
        nonces.set(getAddress(sender), (nonces.get(getAddress(sender)) ?? 0) + 1);
        applyResolution(sender, requestId, approved, requestHash, observedAt, validUntil, txHash);
        return txHash;
      }
      if (method === "eth_getTransactionReceipt") {
        const [txHash] = params as [Hex];
        return receipts.get(txHash) ?? null;
      }
      throw new Error(`Unhandled RPC method: ${method}`);
    },
  });

  return {
    transport,
    genesisHash,
    requests,
    createEmergencyRequest,
    applyResolution,
    getTimestamp: () => timestamp,
    setOracleEligible: (value: boolean) => {
      oracleEligible = value;
    },
  };
}

async function readJsonLines(path: string): Promise<OracleDecisionRecord[]> {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OracleDecisionRecord);
}

test("oracle worker resolves valid and negative emergency requests, bounds retries, fails closed, and recovers from checkpoints", async (t) => {
  const controller: Address = "0x1111111111111111111111111111111111111111";
  const registry: Address = "0x2222222222222222222222222222222222222222";
  const patientAccount = privateKeyToAccount(generatePrivateKey());
  const clinicianBAccount = privateKeyToAccount(generatePrivateKey());
  const clinicianAAccount = privateKeyToAccount(generatePrivateKey());
  const oracleBAccount = privateKeyToAccount(generatePrivateKey());

  const facilityA = bytes32(1);
  const facilityB = bytes32(2);
  const record1 = bytes32(10);
  const record2 = bytes32(11);

  const sim = createSimulatedBesuChain({
    controller,
    registry,
    oracleAddress: oracleBAccount.address,
    oracleFacilityId: facilityB,
    initialTimestamp: 10_000n,
  });

  const serviceToken = "facility-b-oracle-service-token-2026";
  const mockApi = createMockFacilityApi({
    facilityId: facilityB,
    serviceToken,
  });
  mockApi.server.listen(0, "127.0.0.1");
  await once(mockApi.server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => mockApi.server.close((err) => (err ? reject(err) : resolve()))));
  const address = mockApi.server.address();
  assert.ok(address && typeof address !== "string");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const tempDir = await mkdtemp(join(tmpdir(), "rme-oracle-worker-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const checkpointPath = join(tempDir, "checkpoint.json");
  const auditPath = join(tempDir, "decisions.jsonl");

  const oracleChain = await connectOracle({
    rpcUrl: "http://127.0.0.1:8545",
    account: oracleBAccount,
    controller,
    registry,
    genesisHash: sim.genesisHash,
    transport: sim.transport,
  });

  const recordedSleeps: number[] = [];
  const worker = createOracleWorker({
    chain: oracleChain,
    apiBaseUrl,
    serviceToken,
    checkpointPath,
    auditPath,
    sleep: async (ms) => {
      recordedSleeps.push(ms);
    },
  });

  // 1. Positive emergency request (Request 1) + unrelated Facility A request (Request 2, ignored by Facility B worker).
  const encounter1 = bytes32(101);
  const salt1 = bytes32(201);
  const evidence1 = "IGD-TRIAGE:ESI-1;UNRESPONSIVE;CARDIAC-ARREST";
  const commitment1 = hashClinicalEvidence(salt1, evidence1);

  const req1 = sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianBAccount.address,
    requesterFacilityId: facilityB,
    encounterId: encounter1,
    recordIds: [record1, record2],
    reasonCode: 1,
    evidenceCommitment: commitment1,
    requestedDuration: 300n,
  });
  sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianAAccount.address,
    requesterFacilityId: facilityA,
    encounterId: bytes32(102),
    recordIds: [record1],
    reasonCode: 1,
    evidenceCommitment: commitment1,
    requestedDuration: 300n,
  });

  const now1 = Number(sim.getTimestamp());
  const assessment1: SyntheticClinicalAssessment = {
    encounterId: encounter1,
    facilityId: facilityB,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianBAccount.address,
    attendingClinicianWallet: clinicianBAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "resuscitation",
    responsiveness: "unresponsive",
    consentCapable: false,
    evidence: { salt: salt1, canonicalEvidence: evidence1 },
    observedAt: now1,
    validitySeconds: 60,
  };
  mockApi.upsert(assessment1);

  const firstSync = await worker.syncOnce();
  assert.equal(firstSync.decisions.length, 1);
  assert.equal(firstSync.decisions[0].requestId, "1");
  assert.equal(firstSync.decisions[0].outcome, "approved");
  assert.equal(firstSync.decisions[0].attempts, 1);
  assert.ok(firstSync.decisions[0].transactionHash);

  const req1State = sim.requests.get(1n)!;
  assert.equal(req1State.status, 2); // ACTIVE
  assert.equal(
    req1State.attestationHash,
    hashEmergencyAttestation({
      chainId: 1337n,
      controller,
      requestId: 1n,
      requestHash: req1.requestHash,
      approved: true,
      observedAt: BigInt(now1),
      validUntil: BigInt(now1 + 60),
    }),
  );

  // Facility A's request (ID 2) was ignored by Facility B's worker and stays PENDING.
  assert.equal(sim.requests.get(2n)!.status, 0);

  // 2. Negative clinical facts (Request 3): EMER visit where patient is alert -> REJECTED on-chain.
  const encounter3 = bytes32(103);
  const commitment3 = hashClinicalEvidence(bytes32(203), "IGD-TRIAGE:ESI-2;ALERT;CONSENT-CAPABLE");
  sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianBAccount.address,
    requesterFacilityId: facilityB,
    encounterId: encounter3,
    recordIds: [record1],
    reasonCode: 2,
    evidenceCommitment: commitment3,
    requestedDuration: 300n,
  });
  const now3 = Number(sim.getTimestamp());
  mockApi.upsert({
    ...assessment1,
    encounterId: encounter3,
    responsiveness: "alert",
    consentCapable: true,
    evidence: { commitment: commitment3 },
    observedAt: now3,
  });

  const secondSync = await worker.syncOnce();
  assert.equal(secondSync.decisions.length, 1);
  assert.equal(secondSync.decisions[0].requestId, "3");
  assert.equal(secondSync.decisions[0].outcome, "rejected");
  const req3State = sim.requests.get(3n)!;
  assert.equal(req3State.status, 1); // REJECTED
  assert.equal(req3State.activatedAt, 0n);
  assert.equal(req3State.expiresAt, 0n);

  // 3. Bounded retry with [1000, 2000] backoff (Request 4): first two HTTP calls fail with 503, third succeeds.
  const encounter4 = bytes32(104);
  const commitment4 = hashClinicalEvidence(bytes32(204), "IGD-TRIAGE:ESI-1;UNRESPONSIVE;TRAUMA");
  sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianBAccount.address,
    requesterFacilityId: facilityB,
    encounterId: encounter4,
    recordIds: [record1],
    reasonCode: 3,
    evidenceCommitment: commitment4,
    requestedDuration: 300n,
  });
  const now4 = Number(sim.getTimestamp());
  mockApi.upsert({
    ...assessment1,
    encounterId: encounter4,
    evidence: { commitment: commitment4 },
    observedAt: now4,
  });

  let callCount = 0;
  const flakyWorker = createOracleWorker({
    chain: oracleChain,
    apiBaseUrl,
    serviceToken,
    checkpointPath,
    auditPath,
    fetchImpl: async (input, init) => {
      callCount += 1;
      if (callCount <= 2) {
        return new Response(JSON.stringify({ error: "temporary_outage" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fetch(input, init);
    },
    sleep: async (ms) => {
      recordedSleeps.push(ms);
    },
  });

  recordedSleeps.length = 0;
  const thirdSync = await flakyWorker.syncOnce();
  assert.equal(thirdSync.decisions.length, 1);
  assert.equal(thirdSync.decisions[0].requestId, "4");
  assert.equal(thirdSync.decisions[0].outcome, "approved");
  assert.equal(thirdSync.decisions[0].attempts, 3);
  assert.deepEqual(recordedSleeps, [1_000, 2_000]);

  // 4. Fail-closed on binding mismatch (Request 5): API returns mismatched evidenceCommitment -> abstained, stays PENDING.
  const encounter5 = bytes32(105);
  const commitment5 = hashClinicalEvidence(bytes32(205), "IGD-TRIAGE:DOCTOR-CLAIMED");
  const wrongApiCommitment5 = hashClinicalEvidence(bytes32(206), "IGD-TRIAGE:HOSPITAL-RECORDED-DIFFERENT");
  sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianBAccount.address,
    requesterFacilityId: facilityB,
    encounterId: encounter5,
    recordIds: [record1],
    reasonCode: 4,
    evidenceCommitment: commitment5,
    requestedDuration: 300n,
  });
  const now5 = Number(sim.getTimestamp());
  mockApi.upsert({
    ...assessment1,
    encounterId: encounter5,
    evidence: { commitment: wrongApiCommitment5 },
    observedAt: now5,
  });

  const fourthSync = await worker.syncOnce();
  assert.equal(fourthSync.decisions.length, 1);
  assert.equal(fourthSync.decisions[0].requestId, "5");
  assert.equal(fourthSync.decisions[0].outcome, "abstained");
  assert.equal(fourthSync.decisions[0].reason, "evidence_mismatch");
  assert.equal(fourthSync.decisions[0].transactionHash, undefined);
  assert.equal(sim.requests.get(5n)!.status, 0); // Still PENDING on-chain, never approved!

  // 5. Crash recovery & idempotency:
  // Create Request 6, resolve it on-chain before worker runs (simulating crash after tx confirmation before checkpoint save).
  const encounter6 = bytes32(106);
  const commitment6 = hashClinicalEvidence(bytes32(207), "IGD-TRIAGE:CRASH-RECOVERY-TEST");
  const req6 = sim.createEmergencyRequest({
    patient: patientAccount.address,
    clinician: clinicianBAccount.address,
    requesterFacilityId: facilityB,
    encounterId: encounter6,
    recordIds: [record1],
    reasonCode: 5,
    evidenceCommitment: commitment6,
    requestedDuration: 300n,
  });
  const now6 = sim.getTimestamp();
  sim.applyResolution(
    oracleBAccount.address,
    6n,
    true,
    req6.requestHash,
    now6,
    now6 + 60n,
    keccak256(toHex("pre-crash-tx-6")),
  );

  let apiCalledForAlreadyResolved = false;
  const recoveryWorker = createOracleWorker({
    chain: oracleChain,
    apiBaseUrl,
    serviceToken,
    checkpointPath,
    auditPath,
    fetchImpl: async (input, init) => {
      apiCalledForAlreadyResolved = true;
      return fetch(input, init);
    },
  });

  const fifthSync = await recoveryWorker.syncOnce();
  assert.equal(fifthSync.decisions.length, 1);
  assert.equal(fifthSync.decisions[0].requestId, "6");
  assert.equal(fifthSync.decisions[0].outcome, "already_resolved");
  assert.equal(fifthSync.decisions[0].attempts, 0);
  assert.equal(apiCalledForAlreadyResolved, false);

  // Re-running syncOnce on a restarted worker with no new blocks makes zero decisions.
  const sixthSync = await recoveryWorker.syncOnce();
  assert.equal(sixthSync.decisions.length, 0);

  // Verify audit log and checkpoint integrity.
  const auditEntries = await readJsonLines(auditPath);
  assert.deepEqual(
    auditEntries.map((entry) => ({ id: entry.requestId, outcome: entry.outcome })),
    [
      { id: "1", outcome: "approved" },
      { id: "3", outcome: "rejected" },
      { id: "4", outcome: "approved" },
      { id: "5", outcome: "abstained" },
      { id: "6", outcome: "already_resolved" },
    ],
  );

  // Stale checkpoint with a mismatched genesisHash must be rejected on reload.
  const savedCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  await writeFile(checkpointPath, JSON.stringify({ ...savedCheckpoint, genesisHash: bytes32(999) }));
  await assert.rejects(() => recoveryWorker.loadCheckpoint(), /checkpoint does not match/i);
});
