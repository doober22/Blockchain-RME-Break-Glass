import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { decodeEventLog, keccak256, parseAbi, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { besuClients, connectGateway, controllerAbi } from "./chain.ts";
import { createGateway } from "./http.ts";
import { recordFile, recordStore } from "./records.ts";
import { loadDeployment } from "./start.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const registryAbi = parseAbi([
  "function registerFacility(bytes32 facilityId)",
  "function registerParticipant(address account, bytes32 role, bytes32 facilityId, uint64 validUntil)",
]);

test("Besu-backed normal consent delivers a record once per proof and denies revoked or tampered reads", { timeout: 360_000 }, async (t) => {
  loadEnvFile(join(root, ".env"));
  const adminKey = process.env.DEPLOYER_PRIVATE_KEY;
  assert.ok(adminKey && /^0x[0-9a-fA-F]{64}$/.test(adminKey), "Initialize the Besu development chain first");
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  assert.ok(["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl), "Only the local demo chain is supported");
  const deployment = await loadDeployment();
  const actors = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
  const [patientAccount, clinicianAccount, gatewayAccount] = actors;
  const adminAccount = privateKeyToAccount(adminKey as Hex);
  const runChain = (...args: string[]) => execFileSync(process.execPath, [join(root, "infrastructure", "chain.mjs"), ...args],
    { cwd: root, stdio: "inherit", timeout: 180_000 });
  // The integration command provisions new wallets on the local development chain.
  runChain("stop");
  try {
    for (const actor of actors) runChain("approve", "--address", actor.address);
  } finally {
    runChain("start");
  }
  const chain = await connectGateway({ ...deployment, rpcUrl, account: gatewayAccount });
  for (const account of [patientAccount, gatewayAccount]) runChain("fund", "--address", account.address, "--amount", "1");

  const { reader, wallet } = besuClients(rpcUrl);
  const admin = wallet(adminAccount), patient = wallet(patientAccount), facilityGateway = wallet(gatewayAccount);
  const registry = { abi: registryAbi, address: deployment.registry };
  const controller = { abi: controllerAbi, address: deployment.controller };
  const confirmed = async (hash: Hex) => {
    const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 15_000, retryCount: 0 });
    assert.equal(receipt.status, "success");
    return receipt;
  };
  const facility = keccak256(toHex(`gateway-fixture:${gatewayAccount.address}`));
  const validUntil = (await reader.getBlock()).timestamp + 3600n;
  await confirmed(await admin.writeContract({ ...registry, functionName: "registerFacility", args: [facility] }));
  for (const [index, role] of ["PATIENT_ROLE", "CLINICIAN_ROLE", "GATEWAY_ROLE"].entries()) {
    await confirmed(await admin.writeContract({ ...registry, functionName: "registerParticipant",
      args: [actors[index].address, keccak256(toHex(role)), facility, validUntil] }));
  }
  const runtime = join(root, "gateway", ".runtime");
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, "besu-test-"));
  const auditPath = join(directory, "delivery.jsonl");
  const store = recordStore(directory, randomBytes(32));
  const recordId = keccak256(toHex(`synthetic-record:${gatewayAccount.address}`));
  const record = Buffer.from(JSON.stringify({ synthetic: true, sample: "normal consent integration fixture" }));
  const ciphertextHash = await store.put(recordId, record);
  await confirmed(await facilityGateway.writeContract({ ...controller, functionName: "registerRecord",
    args: [recordId, patientAccount.address, ciphertextHash, 1] }));
  async function grant() {
    const receipt = await confirmed(await patient.writeContract({ ...controller, functionName: "grantConsent",
      args: [clinicianAccount.address, recordId, validUntil] }));
    const [event] = receipt.logs.map((log) => decodeEventLog({ abi: controllerAbi, eventName: "ConsentGranted", ...log }));
    return { consentId: event.args.consentId, grantTx: receipt.transactionHash };
  }
  const initial = await grant();
  const origin = () => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const server = createGateway({ chain, store, auditPath, origin, gateway: gatewayAccount.address, controller: deployment.controller });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const post = (path: string, payload: object) => fetch(origin() + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000),
  });
  const makeProof = async (consentId: bigint, signer = clinicianAccount) => {
    const response = await post("/challenge", { clinician: clinicianAccount.address, recordId, consentId: consentId.toString() });
    assert.equal(response.status, 201);
    const { nonce, message } = await response.json() as { nonce: string; message: string };
    return { nonce, signature: await signer.signMessage({ message }) };
  };
  async function deny(proof: Awaited<ReturnType<typeof makeProof>>, status: number, code: string) {
    const response = await post("/records/read", proof);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-access-id"), null);
    assert.deepEqual(await response.json(), { error: code });
  }

  await deny(await makeProof(initial.consentId, patientAccount), 401, "invalid_signature");
  const proof = await makeProof(initial.consentId);
  const allowed = await post("/records/read", proof);
  assert.equal(allowed.status, 200);
  const accessId = allowed.headers.get("x-access-id");
  assert.match(accessId ?? "", /^0x[0-9a-f]{64}$/);
  assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), record);
  await deny(proof, 401, "invalid_challenge");

  const revoked = await confirmed(await patient.writeContract({ ...controller, functionName: "revokeConsent", args: [initial.consentId] }));
  await deny(await makeProof(initial.consentId), 403, "read_denied");
  const second = await grant();
  const envelope = await readFile(recordFile(directory, recordId));
  envelope[envelope.length - 1] ^= 1;
  await writeFile(recordFile(directory, recordId), envelope);
  await deny(await makeProof(second.consentId), 502, "record_integrity_failed");

  // HTTP finish and the corresponding append can complete independently of the response reader.
  type Entry = { accessId: Hex; transaction?: Hex; outcome: string };
  let audit: Entry[] = [];
  for (let i = 0; i < 20; i++) {
    audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    if (audit.some((entry) => entry.outcome === "integrity_failed")) break;
    await pause(50);
  }
  const delivery = audit.find((entry) => entry.accessId === accessId && entry.outcome === "response_finished");
  assert.ok(delivery?.transaction);
  assert.ok(audit.some((entry) => entry.accessId === accessId && entry.outcome === "authorized" && entry.transaction === delivery.transaction));
  assert.ok(audit.some((entry) => entry.outcome === "denied" && !entry.transaction));
  const tampered = audit.find((entry) => entry.outcome === "integrity_failed");
  assert.ok(tampered?.transaction);
  assert.ok(!audit.some((entry) => entry.accessId === tampered.accessId && entry.outcome === "response_finished"));
  const evidence = { chainId: 1337, genesisHash: deployment.genesisHash, controller: deployment.controller,
    recordId, ciphertextHash, normalConsent: { grant: initial.grantTx, authorization: delivery.transaction, accessId, revoke: revoked.transactionHash },
    outcomes: { delivered: 200, wrongSigner: 401, replay: 401, revoked: 403, tampered: 502 },
    tamperedAuthorization: tampered.transaction };
  await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  t.diagnostic(`Public receipt evidence: ${join(directory, "evidence.json")}`);
});
