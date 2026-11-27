import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
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
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hashClinicalEvidence } from "../oracle/emergency-context.ts";
import { createMockFacilityApi } from "../oracle/mock-api.ts";
import { connectOracle, createOracleWorker } from "../oracle/worker.ts";
import { hashEmergencyAttestation } from "../smart-contract/integration/attestation-hash.ts";
import { hashEmergencyRequest } from "../smart-contract/integration/request-hash.ts";
import { EMERGENCY_MODE, NORMAL_MODE, connectGateway, controllerAbi } from "./chain.ts";
import { createGateway } from "./http.ts";
import { recordFile, recordStore } from "./records.ts";

const bytes32 = (value: number): Hex => toHex(value, { size: 32 });
const PATIENT_ROLE = keccak256(toHex("PATIENT_ROLE"));
const CLINICIAN_ROLE = keccak256(toHex("CLINICIAN_ROLE"));
const AUDITOR_ROLE = keccak256(toHex("AUDITOR_ROLE"));
const ORACLE_ROLE = keccak256(toHex("ORACLE_ROLE"));
const GATEWAY_ROLE = keccak256(toHex("GATEWAY_ROLE"));
const MISUSE_CLOSURE_CODE = 65_535;

const combinedAbi = [
  ...controllerAbi,
  {
    type: "function",
    name: "ORACLE_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "GATEWAY_ROLE",
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

interface SimParticipant {
  exists: boolean;
  role: Hex;
  facilityId: Hex;
  active: boolean;
  validUntil: bigint;
}

interface SimRecord {
  exists: boolean;
  patient: Address;
  facilityId: Hex;
  ciphertextHash: Hex;
  categoryCode: number;
  active: boolean;
}

interface SimConsent {
  exists: boolean;
  patient: Address;
  clinician: Address;
  recordId: Hex;
  createdAt: bigint;
  expiresAt: bigint;
  revoked: boolean;
}

interface SimEmergencyRequest {
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

function createEndToEndConsortiumLedger(config: {
  controller: Address;
  registry: Address;
  initialTimestamp: bigint;
}) {
  let blockNumber = 0n;
  let timestamp = config.initialTimestamp;
  const genesisHash = keccak256(toHex("e2e-break-glass-genesis-1337"));
  const blocks = new Map<bigint, { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }>();
  blocks.set(0n, { number: 0n, hash: genesisHash, parentHash: bytes32(0), timestamp });

  const facilities = new Map<Hex, boolean>();
  const participants = new Map<Address, SimParticipant>();
  const records = new Map<Hex, SimRecord>();
  const consents = new Map<bigint, SimConsent>();
  const requests = new Map<bigint, SimEmergencyRequest>();
  const reviews = new Map<bigint, { reviewer: Address; verdict: number; reportCommitment: Hex; reviewedAt: bigint }>();
  const usedAccessIds = new Set<Hex>();
  const nonces = new Map<Address, number>();
  const receipts = new Map<Hex, object>();
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

  let consentCounter = 0n;
  let requestCounter = 0n;

  function mineBlock(advanceSeconds = 0n) {
    const parent = blocks.get(blockNumber)!;
    blockNumber += 1n;
    timestamp += advanceSeconds;
    const hash = keccak256(toHex(`e2e-block:${blockNumber}:${timestamp}:${parent.hash}`));
    const block = { number: blockNumber, hash, parentHash: parent.hash, timestamp };
    blocks.set(blockNumber, block);
    return block;
  }

  function isEligible(account: Address, role: Hex): boolean {
    const p = participants.get(getAddress(account));
    if (!p || !p.exists || !p.active || timestamp >= p.validUntil || p.role.toLowerCase() !== role.toLowerCase()) {
      return false;
    }
    if (
      role.toLowerCase() === CLINICIAN_ROLE.toLowerCase() ||
      role.toLowerCase() === ORACLE_ROLE.toLowerCase() ||
      role.toLowerCase() === GATEWAY_ROLE.toLowerCase()
    ) {
      return facilities.get(p.facilityId.toLowerCase() as Hex) === true;
    }
    return true;
  }

  function canRead(clinician: Address, recordId: Hex, mode: number, grantId: bigint): boolean {
    if (mode !== NORMAL_MODE && mode !== EMERGENCY_MODE) return false;
    const record = records.get(recordId.toLowerCase() as Hex);
    if (!record || !record.exists || !record.active) return false;
    const doc = getAddress(clinician);
    if (mode === NORMAL_MODE) {
      const consent = consents.get(grantId);
      if (
        !consent ||
        !consent.exists ||
        consent.revoked ||
        timestamp >= consent.expiresAt ||
        consent.clinician !== doc ||
        consent.recordId !== recordId.toLowerCase() ||
        consent.patient !== record.patient
      ) {
        return false;
      }
    } else {
      const req = requests.get(grantId);
      const docParticipant = participants.get(doc);
      if (
        !req ||
        !req.exists ||
        req.status !== 2 ||
        timestamp >= req.expiresAt ||
        req.clinician !== doc ||
        req.patient !== record.patient ||
        !req.recordIds.includes(recordId.toLowerCase() as Hex) ||
        !docParticipant ||
        docParticipant.facilityId.toLowerCase() !== req.requesterFacilityId.toLowerCase()
      ) {
        return false;
      }
    }
    return (
      isEligible(record.patient, PATIENT_ROLE) &&
      isEligible(doc, CLINICIAN_ROLE) &&
      facilities.get(record.facilityId.toLowerCase() as Hex) === true
    );
  }

  function registerFacility(facilityId: Hex) {
    facilities.set(facilityId.toLowerCase() as Hex, true);
  }

  function registerParticipant(account: Address, role: Hex, facilityId: Hex, validUntil: bigint) {
    participants.set(getAddress(account), {
      exists: true,
      role: role.toLowerCase() as Hex,
      facilityId: facilityId.toLowerCase() as Hex,
      active: true,
      validUntil,
    });
  }

  function registerRecord(gateway: Address, recordId: Hex, patient: Address, ciphertextHash: Hex, categoryCode = 1) {
    if (!isEligible(gateway, GATEWAY_ROLE)) throw new Error("IneligibleGateway");
    const gw = participants.get(getAddress(gateway))!;
    records.set(recordId.toLowerCase() as Hex, {
      exists: true,
      patient: getAddress(patient),
      facilityId: gw.facilityId,
      ciphertextHash: ciphertextHash.toLowerCase() as Hex,
      categoryCode,
      active: true,
    });
  }

  function grantConsent(patient: Address, clinician: Address, recordId: Hex, expiresAt: bigint): bigint {
    const rec = records.get(recordId.toLowerCase() as Hex);
    if (!rec || rec.patient !== getAddress(patient)) throw new Error("NotRecordOwner");
    const block = mineBlock(0n);
    consentCounter += 1n;
    consents.set(consentCounter, {
      exists: true,
      patient: getAddress(patient),
      clinician: getAddress(clinician),
      recordId: recordId.toLowerCase() as Hex,
      createdAt: block.timestamp,
      expiresAt,
      revoked: false,
    });
    return consentCounter;
  }

  function requestEmergency(input: {
    clinician: Address;
    patient: Address;
    recordIds: Hex[];
    encounterId: Hex;
    reasonCode: number;
    evidenceCommitment: Hex;
    duration: bigint;
  }): SimEmergencyRequest {
    if (!isEligible(input.clinician, CLINICIAN_ROLE)) throw new Error("IneligibleClinician");
    const doc = participants.get(getAddress(input.clinician))!;
    const block = mineBlock(0n);
    requestCounter += 1n;
    const requestId = requestCounter;
    const createdAt = block.timestamp;
    const decisionDeadline = createdAt + 120n;
    const normalizedRecords = input.recordIds.map((id) => id.toLowerCase() as Hex);
    const requestHash = hashEmergencyRequest({
      chainId: 1337n,
      controller: config.controller,
      requestId,
      patient: getAddress(input.patient),
      clinician: getAddress(input.clinician),
      requesterFacilityId: doc.facilityId,
      encounterId: input.encounterId.toLowerCase() as Hex,
      recordIds: normalizedRecords,
      reasonCode: input.reasonCode,
      evidenceCommitment: input.evidenceCommitment.toLowerCase() as Hex,
      requestedDuration: input.duration,
      decisionDeadline,
    });
    const req: SimEmergencyRequest = {
      exists: true,
      requestId,
      patient: getAddress(input.patient),
      clinician: getAddress(input.clinician),
      requesterFacilityId: doc.facilityId,
      encounterId: input.encounterId.toLowerCase() as Hex,
      recordIds: normalizedRecords,
      reasonCode: input.reasonCode,
      evidenceCommitment: input.evidenceCommitment.toLowerCase() as Hex,
      requestHash,
      requestedDuration: input.duration,
      createdAt,
      decisionDeadline,
      activatedAt: 0n,
      expiresAt: 0n,
      status: 0,
      attestationHash: bytes32(0),
    };
    requests.set(requestId, req);

    const topics = encodeEventTopics({
      abi: controllerAbi,
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
    logs.push({
      address: config.controller,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: keccak256(toHex(`emergency-req-tx:${requestId}`)),
      transactionIndex: 0,
      logIndex: 0,
      data,
      topics,
    });
    return req;
  }

  function closeEmergency(caller: Address, requestId: bigint, closureCode: number) {
    const req = requests.get(requestId);
    if (!req || req.status !== 2) throw new Error("RequestNotActive");
    const addr = getAddress(caller);
    if (addr !== req.patient && addr !== req.clinician && !isEligible(addr, AUDITOR_ROLE)) {
      throw new Error("UnauthorizedClosure");
    }
    if (closureCode === MISUSE_CLOSURE_CODE) throw new Error("ReservedClosureCode");
    mineBlock(0n);
    req.status = 3; // CLOSED
  }

  function submitReview(auditor: Address, requestId: bigint, verdict: number, reportCommitment: Hex) {
    const req = requests.get(requestId);
    if (!req || (req.status !== 2 && req.status !== 3)) throw new Error("RequestNeverActivated");
    const addr = getAddress(auditor);
    if (!isEligible(addr, AUDITOR_ROLE) || addr === req.clinician) throw new Error("IneligibleAuditor");
    if (reviews.has(requestId)) throw new Error("ReviewAlreadySubmitted");
    const block = mineBlock(0n);
    reviews.set(requestId, {
      reviewer: addr,
      verdict,
      reportCommitment: reportCommitment.toLowerCase() as Hex,
      reviewedAt: block.timestamp,
    });
    if (verdict === 1 && req.status === 2) {
      req.status = 3; // Misuse closes active grant
    }
  }

  function storeReceipt(sender: Address, block: { number: bigint; hash: Hex }, txHash: Hex, eventLogs: object[]) {
    receipts.set(txHash, {
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash: block.hash,
      blockNumber: toHex(block.number),
      from: getAddress(sender),
      to: config.controller,
      cumulativeGasUsed: toHex(120_000n),
      gasUsed: toHex(120_000n),
      contractAddress: null,
      logs: eventLogs,
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
        const [filter] = params as [{ fromBlock?: string; toBlock?: string }];
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
        if (decoded.functionName === "GATEWAY_ROLE") {
          return encodeFunctionResult({ abi: combinedAbi, functionName: "GATEWAY_ROLE", result: GATEWAY_ROLE });
        }
        if (decoded.functionName === "isEligible") {
          const [account, role] = decoded.args as [Address, Hex];
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "isEligible",
            result: isEligible(account, role),
          });
        }
        if (decoded.functionName === "getParticipant") {
          const [account] = decoded.args as [Address];
          const p = participants.get(getAddress(account));
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getParticipant",
            result: {
              exists: p?.exists ?? false,
              facilityId: p?.facilityId ?? bytes32(0),
              active: p?.active ?? false,
              validUntil: p?.validUntil ?? 0n,
            },
          });
        }
        if (decoded.functionName === "getRecord") {
          const [recordId] = decoded.args as [Hex];
          const rec = records.get(recordId.toLowerCase() as Hex);
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getRecord",
            result: {
              exists: rec?.exists ?? false,
              patient: rec?.patient ?? "0x0000000000000000000000000000000000000000",
              facilityId: rec?.facilityId ?? bytes32(0),
              ciphertextHash: rec?.ciphertextHash ?? bytes32(0),
              categoryCode: rec?.categoryCode ?? 0,
              active: rec?.active ?? false,
            },
          });
        }
        if (decoded.functionName === "getConsent") {
          const [consentId] = decoded.args as [bigint];
          const c = consents.get(consentId);
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getConsent",
            result: {
              exists: c?.exists ?? false,
              patient: c?.patient ?? "0x0000000000000000000000000000000000000000",
              clinician: c?.clinician ?? "0x0000000000000000000000000000000000000000",
              recordId: c?.recordId ?? bytes32(0),
              createdAt: c?.createdAt ?? 0n,
              expiresAt: c?.expiresAt ?? 0n,
              revoked: c?.revoked ?? false,
            },
          });
        }
        if (decoded.functionName === "getRequest") {
          const [requestId] = decoded.args as [bigint];
          const req = requests.get(requestId);
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getRequest",
            result: {
              exists: req?.exists ?? false,
              patient: req?.patient ?? "0x0000000000000000000000000000000000000000",
              clinician: req?.clinician ?? "0x0000000000000000000000000000000000000000",
              requesterFacilityId: req?.requesterFacilityId ?? bytes32(0),
              encounterId: req?.encounterId ?? bytes32(0),
              reasonCode: req?.reasonCode ?? 0,
              evidenceCommitment: req?.evidenceCommitment ?? bytes32(0),
              requestHash: req?.requestHash ?? bytes32(0),
              requestedDuration: req?.requestedDuration ?? 0n,
              createdAt: req?.createdAt ?? 0n,
              decisionDeadline: req?.decisionDeadline ?? 0n,
              activatedAt: req?.activatedAt ?? 0n,
              expiresAt: req?.expiresAt ?? 0n,
              status: req?.status ?? 0,
              attestationHash: req?.attestationHash ?? bytes32(0),
            },
          });
        }
        if (decoded.functionName === "getRequestRecords") {
          const [requestId] = decoded.args as [bigint];
          const req = requests.get(requestId);
          if (!req || !req.exists) throw new Error("RequestNotFound");
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "getRequestRecords",
            result: req.recordIds,
          });
        }
        if (decoded.functionName === "canRead") {
          const [clinician, recordId, mode, grantId] = decoded.args as [Address, Hex, number, bigint];
          return encodeFunctionResult({
            abi: combinedAbi,
            functionName: "canRead",
            result: canRead(clinician, recordId, Number(mode), grantId),
          });
        }
      }
      if (method === "eth_sendRawTransaction") {
        const [rawTx] = params as [TransactionSerialized];
        const sender = await recoverTransactionAddress({ serializedTransaction: rawTx });
        const parsed = parseTransaction(rawTx);
        const decoded = decodeFunctionData({ abi: controllerAbi, data: parsed.data! });
        const txHash = keccak256(rawTx);
        nonces.set(getAddress(sender), (nonces.get(getAddress(sender)) ?? 0) + 1);

        if (decoded.functionName === "resolveEmergency") {
          const [requestId, approved, requestHash, observedAt, validUntil] = decoded.args;
          const req = requests.get(requestId);
          if (!req || !req.exists) throw new Error("RequestNotFound");
          if (!isEligible(sender, ORACLE_ROLE)) throw new Error("IneligibleOracle");
          const oraclePart = participants.get(getAddress(sender))!;
          if (oraclePart.facilityId !== req.requesterFacilityId) throw new Error("WrongFacility");
          if (req.status !== 0) throw new Error("RequestNotPending");
          const block = mineBlock(0n);
          if (block.timestamp >= req.decisionDeadline) throw new Error("RequestDeadlinePassed");
          if (requestHash.toLowerCase() !== req.requestHash.toLowerCase()) throw new Error("RequestHashMismatch");
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
            abi: controllerAbi,
            eventName: "EmergencyResolved",
            args: { requestId, oracle: getAddress(sender) },
          }) as Hex[];
          const data = encodeAbiParameters(
            parseAbiParameters("bool approved, bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt"),
            [approved, req.attestationHash, req.activatedAt, req.expiresAt],
          );
          storeReceipt(sender, block, txHash, [
            {
              address: config.controller,
              blockNumber: toHex(block.number),
              blockHash: block.hash,
              transactionHash: txHash,
              transactionIndex: "0x0",
              logIndex: "0x0",
              data,
              topics,
              removed: false,
            },
          ]);
          return txHash;
        }

        if (decoded.functionName === "authorizeAccess") {
          const [clinician, recordId, mode, grantId, accessId] = decoded.args;
          const rec = records.get(recordId.toLowerCase() as Hex);
          if (!rec || !rec.exists) throw new Error("RecordNotFound");
          if (!isEligible(sender, GATEWAY_ROLE)) throw new Error("IneligibleGateway");
          const gw = participants.get(getAddress(sender))!;
          if (gw.facilityId !== rec.facilityId) throw new Error("WrongFacility");
          const normalizedAccessId = accessId.toLowerCase() as Hex;
          if (BigInt(normalizedAccessId) === 0n) throw new Error("InvalidAccessId");
          if (usedAccessIds.has(normalizedAccessId)) throw new Error("AccessIdAlreadyUsed");
          if (!canRead(clinician, recordId, Number(mode), grantId)) throw new Error("ReadAccessDenied");
          usedAccessIds.add(normalizedAccessId);
          const block = mineBlock(0n);
          const topics = encodeEventTopics({
            abi: controllerAbi,
            eventName: "AccessAuthorized",
            args: {
              accessId: normalizedAccessId,
              recordId: recordId.toLowerCase() as Hex,
              patient: rec.patient,
            },
          }) as Hex[];
          const data = encodeAbiParameters(
            parseAbiParameters("address clinician, address gateway, uint8 mode, uint256 grantId, uint64 timestamp"),
            [getAddress(clinician), getAddress(sender), Number(mode), grantId, block.timestamp],
          );
          storeReceipt(sender, block, txHash, [
            {
              address: config.controller,
              blockNumber: toHex(block.number),
              blockHash: block.hash,
              transactionHash: txHash,
              transactionIndex: "0x0",
              logIndex: "0x0",
              data,
              topics,
              removed: false,
            },
          ]);
          return txHash;
        }

        throw new Error(`Unsupported transaction method: ${decoded.functionName}`);
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
    getTimestamp: () => timestamp,
    advanceTime: (seconds: bigint) => {
      mineBlock(seconds);
    },
    registerFacility,
    registerParticipant,
    registerRecord,
    grantConsent,
    requestEmergency,
    closeEmergency,
    submitReview,
  };
}

test("facility gateway enforces emergency break-glass grants end to end with oracle resolution, scope, closure, misuse review, expiry, and integrity checks", async (t) => {
  const controller: Address = "0x1111111111111111111111111111111111111111";
  const registry: Address = "0x2222222222222222222222222222222222222222";
  const patientAccount = privateKeyToAccount(generatePrivateKey());
  const clinicianBAccount = privateKeyToAccount(generatePrivateKey());
  const otherClinicianAccount = privateKeyToAccount(generatePrivateKey());
  const gatewayAAccount = privateKeyToAccount(generatePrivateKey());
  const oracleBAccount = privateKeyToAccount(generatePrivateKey());
  const auditorAccount = privateKeyToAccount(generatePrivateKey());

  const facilityA = bytes32(1); // Issuing facility hosting encrypted records and gateway
  const facilityB = bytes32(2); // Requesting IGD facility where clinicianB and oracleB operate
  const initialTime = BigInt(Math.floor(Date.now() / 1000));

  const ledger = createEndToEndConsortiumLedger({
    controller,
    registry,
    initialTimestamp: initialTime,
  });
  const validUntil = initialTime + 3_600n;
  ledger.registerFacility(facilityA);
  ledger.registerFacility(facilityB);
  ledger.registerParticipant(patientAccount.address, PATIENT_ROLE, facilityA, validUntil);
  ledger.registerParticipant(clinicianBAccount.address, CLINICIAN_ROLE, facilityB, validUntil);
  ledger.registerParticipant(otherClinicianAccount.address, CLINICIAN_ROLE, facilityB, validUntil);
  ledger.registerParticipant(gatewayAAccount.address, GATEWAY_ROLE, facilityA, validUntil);
  ledger.registerParticipant(oracleBAccount.address, ORACLE_ROLE, facilityB, validUntil);
  ledger.registerParticipant(auditorAccount.address, AUDITOR_ROLE, facilityA, validUntil);

  const tempDir = await mkdtemp(join(tmpdir(), "rme-break-glass-gateway-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const recordsDir = join(tempDir, "records");
  const deliveryAuditPath = join(tempDir, "delivery.jsonl");
  const oracleCheckpointPath = join(tempDir, "oracle-checkpoint.json");
  const oracleAuditPath = join(tempDir, "oracle-decisions.jsonl");

  const store = recordStore(recordsDir, randomBytes(32));
  const record1Id = keccak256(toHex("record-1:allergy-summary"));
  const record2Id = keccak256(toHex("record-2:cardiac-history"));
  const record3OutScopeId = keccak256(toHex("record-3:unrelated-psychiatric-note"));

  const record1Bytes = Buffer.from(JSON.stringify({ synthetic: true, record: "allergy-summary", bloodType: "O+" }));
  const record2Bytes = Buffer.from(JSON.stringify({ synthetic: true, record: "cardiac-history", note: "prior STEMI" }));
  const record3Bytes = Buffer.from(JSON.stringify({ synthetic: true, record: "out-of-scope" }));

  const hash1 = await store.put(record1Id, record1Bytes);
  const hash2 = await store.put(record2Id, record2Bytes);
  const hash3 = await store.put(record3OutScopeId, record3Bytes);

  ledger.registerRecord(gatewayAAccount.address, record1Id, patientAccount.address, hash1, 1);
  ledger.registerRecord(gatewayAAccount.address, record2Id, patientAccount.address, hash2, 2);
  ledger.registerRecord(gatewayAAccount.address, record3OutScopeId, patientAccount.address, hash3, 3);

  // Start Facility B Mock Hospital API and Oracle Worker
  const serviceToken = "facility-b-emergency-api-token-2026";
  const mockApi = createMockFacilityApi({ facilityId: facilityB, serviceToken });
  mockApi.server.listen(0, "127.0.0.1");
  await once(mockApi.server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => mockApi.server.close((err) => (err ? reject(err) : resolve()))));
  const apiAddr = mockApi.server.address();
  assert.ok(apiAddr && typeof apiAddr !== "string");
  const apiBaseUrl = `http://127.0.0.1:${apiAddr.port}`;

  const oracleChain = await connectOracle({
    rpcUrl: "http://127.0.0.1:8545",
    account: oracleBAccount,
    controller,
    registry,
    genesisHash: ledger.genesisHash,
    transport: ledger.transport,
  });
  const oracleWorker = createOracleWorker({
    chain: oracleChain,
    apiBaseUrl,
    serviceToken,
    checkpointPath: oracleCheckpointPath,
    auditPath: oracleAuditPath,
  });

  // Start Facility A Gateway Server
  const gatewayChain = await connectGateway({
    rpcUrl: "http://127.0.0.1:8545",
    account: gatewayAAccount,
    controller,
    registry,
    genesisHash: ledger.genesisHash,
    transport: ledger.transport,
    clock: () => ledger.getTimestamp(),
  });
  const origin = () => {
    const addr = gatewayServer.address();
    assert.ok(addr && typeof addr !== "string");
    return `http://127.0.0.1:${addr.port}`;
  };
  const gatewayServer = createGateway({
    chain: gatewayChain,
    store,
    auditPath: deliveryAuditPath,
    origin,
    gateway: gatewayAAccount.address,
    controller,
  });
  gatewayServer.listen(0, "127.0.0.1");
  await once(gatewayServer, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => gatewayServer.close((err) => (err ? reject(err) : resolve()))));

  const post = (path: string, payload: object) =>
    fetch(origin() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

  async function makeEmergencyProof(
    requestId: bigint,
    recordId: Hex,
    clinician: Address = clinicianBAccount.address,
    signer: PrivateKeyAccount = clinicianBAccount,
  ) {
    const response = await post("/challenge", {
      clinician,
      recordId,
      mode: EMERGENCY_MODE,
      requestId: requestId.toString(),
    });
    assert.equal(response.status, 201);
    const { nonce, message, mode, grantId } = (await response.json()) as {
      nonce: string;
      message: string;
      mode: number;
      grantId: string;
    };
    assert.equal(mode, EMERGENCY_MODE);
    assert.equal(grantId, requestId.toString());
    assert.match(message, /Mode: EMERGENCY \(1\)/);
    return { nonce, signature: await signer.signMessage({ message }) };
  }

  async function denyRead(proof: { nonce: string; signature: string }, status: number, code: string) {
    const response = await post("/records/read", proof);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-access-id"), null);
    assert.deepEqual(await response.json(), { error: code });
  }

  // Sort scoped records ascending for requestEmergency ([record1Id, record2Id])
  const scopedPair = [record1Id, record2Id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const firstInScope = scopedPair[0];
  const secondInScope = scopedPair[1];
  const firstExpectedBytes = firstInScope === record1Id ? record1Bytes : record2Bytes;

  // 1. Doctor submits emergency request (Grant 1). While still PENDING, gateway denies read (403).
  const encounter1 = bytes32(101);
  const salt1 = bytes32(201);
  const evidence1 = "IGD-TRIAGE:ESI-1;UNRESPONSIVE;ANAPHYLAXIS";
  const commitment1 = hashClinicalEvidence(salt1, evidence1);

  const req1 = ledger.requestEmergency({
    clinician: clinicianBAccount.address,
    patient: patientAccount.address,
    recordIds: scopedPair,
    encounterId: encounter1,
    reasonCode: 1,
    evidenceCommitment: commitment1,
    duration: 300n,
  });
  assert.equal(req1.requestId, 1n);

  await denyRead(await makeEmergencyProof(1n, firstInScope), 403, "read_denied");

  // 2. Oracle worker resolves Grant 1 via Mock Facility API -> ACTIVE.
  mockApi.upsert({
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
    observedAt: Number(ledger.getTimestamp()),
    validitySeconds: 60,
  });
  const sync1 = await oracleWorker.syncOnce();
  assert.equal(sync1.decisions.length, 1);
  assert.equal(sync1.decisions[0].outcome, "approved");

  // Wrong wallet signature on emergency challenge -> 401
  await denyRead(await makeEmergencyProof(1n, firstInScope, clinicianBAccount.address, patientAccount), 401, "invalid_signature");

  // Valid clinician proof for in-scope record -> 200 with decrypted payload and X-Access-Id
  const validProof1 = await makeEmergencyProof(1n, firstInScope);
  const delivered1 = await post("/records/read", validProof1);
  assert.equal(delivered1.status, 200);
  const accessId1 = delivered1.headers.get("x-access-id");
  assert.match(accessId1 ?? "", /^0x[0-9a-f]{64}$/);
  assert.deepEqual(Buffer.from(await delivered1.arrayBuffer()), firstExpectedBytes);

  // Replaying consumed emergency challenge proof -> 401
  await denyRead(validProof1, 401, "invalid_challenge");

  // 3. Out-of-scope record and wrong clinician are both denied (403)
  await denyRead(await makeEmergencyProof(1n, record3OutScopeId), 403, "read_denied");
  await denyRead(
    await makeEmergencyProof(1n, firstInScope, otherClinicianAccount.address, otherClinicianAccount),
    403,
    "read_denied",
  );

  // 4. Patient closes Grant 1 -> subsequent emergency read of second in-scope record is denied (403),
  // while an independent normal consent (mode 0) remains valid (200).
  const normalConsentId = ledger.grantConsent(
    patientAccount.address,
    clinicianBAccount.address,
    firstInScope,
    validUntil,
  );
  ledger.closeEmergency(patientAccount.address, 1n, 10);
  await denyRead(await makeEmergencyProof(1n, secondInScope), 403, "read_denied");

  const normalChallengeRes = await post("/challenge", {
    clinician: clinicianBAccount.address,
    recordId: firstInScope,
    consentId: normalConsentId.toString(),
  });
  assert.equal(normalChallengeRes.status, 201);
  const normalChallenge = (await normalChallengeRes.json()) as { nonce: string; message: string; mode: number };
  assert.equal(normalChallenge.mode, NORMAL_MODE);
  const normalDelivered = await post("/records/read", {
    nonce: normalChallenge.nonce,
    signature: await clinicianBAccount.signMessage({ message: normalChallenge.message }),
  });
  assert.equal(normalDelivered.status, 200);

  // 5. Grant 2: Approved emergency grant closed by Auditor SUSPECTED_MISUSE review -> subsequent read denied (403).
  const encounter2 = bytes32(102);
  const commitment2 = hashClinicalEvidence(bytes32(202), "IGD-TRIAGE:ESI-1;UNRESPONSIVE;TRAUMA");
  ledger.requestEmergency({
    clinician: clinicianBAccount.address,
    patient: patientAccount.address,
    recordIds: [firstInScope],
    encounterId: encounter2,
    reasonCode: 2,
    evidenceCommitment: commitment2,
    duration: 300n,
  });
  mockApi.upsert({
    encounterId: encounter2,
    facilityId: facilityB,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianBAccount.address,
    attendingClinicianWallet: clinicianBAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "emergent",
    responsiveness: "unresponsive",
    consentCapable: false,
    evidence: { commitment: commitment2 },
    observedAt: Number(ledger.getTimestamp()),
  });
  await oracleWorker.syncOnce();
  ledger.submitReview(auditorAccount.address, 2n, 1, bytes32(900)); // SUSPECTED_MISUSE = 1
  await denyRead(await makeEmergencyProof(2n, firstInScope), 403, "read_denied");

  // 6. Grant 3: Oracle rejects negative clinical facts (alert EMER patient) -> gateway denies read (403).
  const encounter3 = bytes32(103);
  const commitment3 = hashClinicalEvidence(bytes32(203), "IGD-TRIAGE:ESI-2;ALERT");
  ledger.requestEmergency({
    clinician: clinicianBAccount.address,
    patient: patientAccount.address,
    recordIds: [firstInScope],
    encounterId: encounter3,
    reasonCode: 3,
    evidenceCommitment: commitment3,
    duration: 300n,
  });
  mockApi.upsert({
    encounterId: encounter3,
    facilityId: facilityB,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianBAccount.address,
    attendingClinicianWallet: clinicianBAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "emergent",
    responsiveness: "alert",
    consentCapable: true,
    evidence: { commitment: commitment3 },
    observedAt: Number(ledger.getTimestamp()),
  });
  const sync3 = await oracleWorker.syncOnce();
  assert.equal(sync3.decisions[0].outcome, "rejected");
  await denyRead(await makeEmergencyProof(3n, firstInScope), 403, "read_denied");

  // 7. Grant 4: Ciphertext tampering on disk during active emergency grant -> 502 record_integrity_failed,
  // and once grant duration expires (now >= expiresAt) -> 403 read_denied.
  const encounter4 = bytes32(104);
  const commitment4 = hashClinicalEvidence(bytes32(204), "IGD-TRIAGE:ESI-1;UNRESPONSIVE;SEPSIS");
  ledger.requestEmergency({
    clinician: clinicianBAccount.address,
    patient: patientAccount.address,
    recordIds: [secondInScope],
    encounterId: encounter4,
    reasonCode: 4,
    evidenceCommitment: commitment4,
    duration: 60n,
  });
  mockApi.upsert({
    encounterId: encounter4,
    facilityId: facilityB,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianBAccount.address,
    attendingClinicianWallet: clinicianBAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "resuscitation",
    responsiveness: "unresponsive",
    consentCapable: false,
    evidence: { commitment: commitment4 },
    observedAt: Number(ledger.getTimestamp()),
  });
  await oracleWorker.syncOnce();

  const secondFile = recordFile(recordsDir, secondInScope);
  const originalEnvelope = await readFile(secondFile);
  const tamperedEnvelope = Buffer.from(originalEnvelope);
  tamperedEnvelope[tamperedEnvelope.length - 1] ^= 1;
  await writeFile(secondFile, tamperedEnvelope);
  await denyRead(await makeEmergencyProof(4n, secondInScope), 502, "record_integrity_failed");
  await writeFile(secondFile, originalEnvelope);

  // Advance chain time to exact grant expiry boundary (60 seconds) -> 403 read_denied without cleanup tx.
  ledger.advanceTime(60n);
  await denyRead(await makeEmergencyProof(4n, secondInScope), 403, "read_denied");

  // Verify delivery.jsonl audit reconciliation distinguishes authorized from delivered and records mode/grantId.
  type AuditEntry = {
    accessId: Hex;
    mode: number;
    grantId: string;
    recordId: Hex;
    clinician: Address;
    transaction?: Hex;
    outcome: string;
  };
  let audit: AuditEntry[] = [];
  for (let i = 0; i < 20; i++) {
    audit = (await readFile(deliveryAuditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AuditEntry);
    if (audit.filter((entry) => entry.outcome === "denied").length >= 6) break;
    await pause(25);
  }

  const emergencyDelivered = audit.find(
    (entry) => entry.accessId === accessId1 && entry.outcome === "response_finished",
  );
  assert.ok(emergencyDelivered?.transaction);
  assert.equal(emergencyDelivered.mode, EMERGENCY_MODE);
  assert.equal(emergencyDelivered.grantId, "1");
  assert.ok(
    audit.some(
      (entry) =>
        entry.accessId === accessId1 &&
        entry.outcome === "authorized" &&
        entry.transaction === emergencyDelivered.transaction,
    ),
  );

  const emergencyTampered = audit.find((entry) => entry.mode === EMERGENCY_MODE && entry.outcome === "integrity_failed");
  assert.ok(emergencyTampered?.transaction);
  assert.equal(emergencyTampered.grantId, "4");
  assert.ok(!audit.some((entry) => entry.accessId === emergencyTampered.accessId && entry.outcome === "response_finished"));
});
