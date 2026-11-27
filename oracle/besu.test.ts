import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEventLog, keccak256, parseAbi, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashClinicalEvidence } from "./emergency-context.ts";
import { createMockFacilityApi } from "./mock-api.ts";
import { loadOracleDeployment } from "./start.ts";
import { connectOracle, createOracleWorker, oracleClients, oracleControllerAbi } from "./worker.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const registrySetupAbi = parseAbi([
  "function registerFacility(bytes32 facilityId)",
  "function registerParticipant(address account, bytes32 role, bytes32 facilityId, uint64 validUntil)",
]);
const controllerSetupAbi = [
  ...oracleControllerAbi,
  ...parseAbi([
    "function registerRecord(bytes32 recordId, address patient, bytes32 ciphertextHash, uint16 categoryCode)",
    "function requestEmergency(address patient, bytes32[] recordIds, bytes32 encounterId, uint16 reasonCode, bytes32 evidenceCommitment, uint64 duration) returns (uint256 requestId)",
    "function canRead(address clinician, bytes32 recordId, uint8 mode, uint256 grantId) view returns (bool)",
  ]),
] as const;

test("Besu-backed oracle worker resolves approved and rejected emergency requests and abstains on tampered evidence", { timeout: 360_000 }, async (t) => {
  loadEnvFile(join(root, ".env"));
  const adminKey = process.env.DEPLOYER_PRIVATE_KEY;
  assert.ok(adminKey && /^0x[0-9a-fA-F]{64}$/.test(adminKey), "Initialize the Besu development chain first");
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  assert.ok(["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl), "Only the local demo chain is supported");
  const deployment = await loadOracleDeployment();

  const actors = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
  const [patientAccount, clinicianAccount, gatewayAccount, oracleAccount] = actors;
  const adminAccount = privateKeyToAccount(adminKey as Hex);
  const runChain = (...args: string[]) =>
    execFileSync(process.execPath, [join(root, "infrastructure", "chain.mjs"), ...args], {
      cwd: root,
      stdio: "inherit",
      timeout: 180_000,
    });

  runChain("stop");
  try {
    for (const actor of actors) runChain("approve", "--address", actor.address);
  } finally {
    runChain("start");
  }
  for (const account of [clinicianAccount, gatewayAccount, oracleAccount]) {
    runChain("fund", "--address", account.address, "--amount", "1");
  }

  const { reader, wallet } = oracleClients(rpcUrl);
  const admin = wallet(adminAccount);
  const clinician = wallet(clinicianAccount);
  const facilityGateway = wallet(gatewayAccount);
  const registry = { abi: registrySetupAbi, address: deployment.registry };
  const controller = { abi: controllerSetupAbi, address: deployment.controller };

  const confirmed = async (hash: Hex) => {
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 15_000, retryCount: 0 });
    assert.equal(receipt.status, "success");
    return receipt;
  };

  const facility = keccak256(toHex(`oracle-fixture:${oracleAccount.address}`));
  const validUntil = (await reader.getBlock()).timestamp + 3_600n;
  await confirmed(await admin.writeContract({ ...registry, functionName: "registerFacility", args: [facility] }));
  for (const [account, role] of [
    [patientAccount.address, "PATIENT_ROLE"],
    [clinicianAccount.address, "CLINICIAN_ROLE"],
    [gatewayAccount.address, "GATEWAY_ROLE"],
    [oracleAccount.address, "ORACLE_ROLE"],
  ] as const) {
    await confirmed(
      await admin.writeContract({
        ...registry,
        functionName: "registerParticipant",
        args: [account, keccak256(toHex(role)), facility, validUntil],
      }),
    );
  }

  const recordId = keccak256(toHex(`oracle-record:${oracleAccount.address}`));
  const ciphertextHash = keccak256(toHex(`oracle-ciphertext:${oracleAccount.address}`));
  await confirmed(
    await facilityGateway.writeContract({
      ...controller,
      functionName: "registerRecord",
      args: [recordId, patientAccount.address, ciphertextHash, 1],
    }),
  );

  const serviceToken = "besu-oracle-facility-service-token";
  const mockApi = createMockFacilityApi({ facilityId: facility, serviceToken });
  mockApi.server.listen(0, "127.0.0.1");
  await once(mockApi.server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => mockApi.server.close((err) => (err ? reject(err) : resolve()))));
  const address = mockApi.server.address();
  assert.ok(address && typeof address !== "string");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const runtimeDir = join(root, "oracle", ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const testDir = await mkdtemp(join(runtimeDir, "besu-test-"));
  const checkpointPath = join(testDir, "checkpoint.json");
  const auditPath = join(testDir, "decisions.jsonl");

  const oracleChain = await connectOracle({ ...deployment, rpcUrl, account: oracleAccount });
  const worker = createOracleWorker({
    chain: oracleChain,
    apiBaseUrl,
    serviceToken,
    checkpointPath,
    auditPath,
  });

  // Request 1: Valid emergency -> approved
  const encounterApproved = keccak256(toHex(`encounter-approved:${oracleAccount.address}`));
  const saltApproved = keccak256(toHex(`salt-approved:${oracleAccount.address}`));
  const evidenceApproved = "IGD-TRIAGE:ESI-1;UNRESPONSIVE";
  const commitmentApproved = hashClinicalEvidence(saltApproved, evidenceApproved);
  const req1Receipt = await confirmed(
    await clinician.writeContract({
      ...controller,
      functionName: "requestEmergency",
      args: [patientAccount.address, [recordId], encounterApproved, 1, commitmentApproved, 300n],
    }),
  );
  const [req1Event] = req1Receipt.logs.map((log) =>
    decodeEventLog({ abi: controllerSetupAbi, eventName: "EmergencyRequested", ...log }),
  );
  const observed1 = Number((await reader.getBlock({ blockNumber: req1Receipt.blockNumber })).timestamp);
  mockApi.upsert({
    encounterId: encounterApproved,
    facilityId: facility,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianAccount.address,
    attendingClinicianWallet: clinicianAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "resuscitation",
    responsiveness: "unresponsive",
    consentCapable: false,
    evidence: { salt: saltApproved, canonicalEvidence: evidenceApproved },
    observedAt: observed1,
  });

  const sync1 = await worker.syncOnce();
  const approvedDecision = sync1.decisions.find((d) => d.requestId === req1Event.args.requestId.toString());
  assert.ok(approvedDecision);
  assert.equal(approvedDecision.outcome, "approved");
  assert.ok(approvedDecision.transactionHash);
  assert.equal(
    await reader.readContract({
      ...controller,
      functionName: "canRead",
      args: [clinicianAccount.address, recordId, 1, req1Event.args.requestId],
    }),
    true,
  );

  // Request 2: Patient alert/consentCapable -> rejected
  const encounterRejected = keccak256(toHex(`encounter-rejected:${oracleAccount.address}`));
  const commitmentRejected = hashClinicalEvidence(saltApproved, "IGD-TRIAGE:ESI-2;ALERT");
  const req2Receipt = await confirmed(
    await clinician.writeContract({
      ...controller,
      functionName: "requestEmergency",
      args: [patientAccount.address, [recordId], encounterRejected, 2, commitmentRejected, 300n],
    }),
  );
  const [req2Event] = req2Receipt.logs.map((log) =>
    decodeEventLog({ abi: controllerSetupAbi, eventName: "EmergencyRequested", ...log }),
  );
  const observed2 = Number((await reader.getBlock({ blockNumber: req2Receipt.blockNumber })).timestamp);
  mockApi.upsert({
    encounterId: encounterRejected,
    facilityId: facility,
    patientWallet: patientAccount.address,
    clinicianWallet: clinicianAccount.address,
    attendingClinicianWallet: clinicianAccount.address,
    encounterStatus: "in-progress",
    visitClass: "EMER",
    triageSeverity: "emergent",
    responsiveness: "alert",
    consentCapable: true,
    evidence: { commitment: commitmentRejected },
    observedAt: observed2,
  });

  const sync2 = await worker.syncOnce();
  const rejectedDecision = sync2.decisions.find((d) => d.requestId === req2Event.args.requestId.toString());
  assert.ok(rejectedDecision);
  assert.equal(rejectedDecision.outcome, "rejected");
  assert.ok(rejectedDecision.transactionHash);
  assert.equal(
    await reader.readContract({
      ...controller,
      functionName: "canRead",
      args: [clinicianAccount.address, recordId, 1, req2Event.args.requestId],
    }),
    false,
  );

  const evidence = {
    chainId: 1337,
    genesisHash: deployment.genesisHash,
    controller: deployment.controller,
    facility,
    recordId,
    approved: {
      requestId: req1Event.args.requestId.toString(),
      requestTx: req1Receipt.transactionHash,
      resolveTx: approvedDecision.transactionHash,
      attestationHash: approvedDecision.attestationHash,
    },
    rejected: {
      requestId: req2Event.args.requestId.toString(),
      requestTx: req2Receipt.transactionHash,
      resolveTx: rejectedDecision.transactionHash,
      attestationHash: rejectedDecision.attestationHash,
    },
    auditEntries: (await readFile(auditPath, "utf8")).trim().split("\n").length,
  };
  await writeFile(join(testDir, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  t.diagnostic(`Public receipt evidence: ${join(testDir, "evidence.json")}`);
});
