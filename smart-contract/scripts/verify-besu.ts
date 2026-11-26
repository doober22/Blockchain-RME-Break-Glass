import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, keccak256, toHex, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { projectRoot, readArtifacts, writeJson } from "./artifacts.ts";
import { DeploymentError, deployContracts } from "./deployment.ts";
import { networkSettings } from "./environment.ts";
import { hashEmergencyAttestation } from "../integration/attestation-hash.ts";
import { hashEmergencyRequest } from "../integration/request-hash.ts";

const root = join(projectRoot, "..");
const chainScript = join(root, "infrastructure", "chain.mjs");
let step = "configuration";

function lifecycle(...args: string[]) {
  execFileSync(process.execPath, [chainScript, ...args], { cwd: root, stdio: "inherit", timeout: 420_000 });
}

async function verify() {
  assert.deepEqual(process.argv.slice(2), ["--reuse"], "Deploy the release separately, then pass --reuse");
  const deploymentsDirectory = join(projectRoot, "deployments");
  assert.ok(existsSync(join(deploymentsDirectory, "1337.json"))
    && !existsSync(join(deploymentsDirectory, "1337.pending.json")), "Verification requires a completed deployment and no pending checkpoint");
  const { chainId, rpcUrl } = networkSettings();
  assert.ok(["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl), "Expected local Besu RPC");
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  assert.ok(key && /^0x[0-9a-fA-F]{64}$/.test(key), "Initialize the local development chain first");
  const chain = defineChain({ id: chainId, name: "RME Besu Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl, { retryCount: 0, timeout: 10_000 });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = (account: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account, chain, transport });
  const admin = wallet(privateKeyToAccount(key as Hex));
  const actors = Array.from({ length: 5 }, () => wallet(privateKeyToAccount(generatePrivateKey())));
  const [patient, clinician, gateway, oracle, auditor] = actors;

  // Approval refuses a running chain. The operator stops an existing chain explicitly.
  step = "account approval and chain startup";
  for (const actor of actors) lifecycle("approve", "--address", actor.account.address);
  lifecycle("start");
  const artifacts = await readArtifacts();
  const options = { publicClient, walletClient: admin, artifacts, deploymentsDirectory,
    abiDirectory: join(projectRoot, "abi") };
  step = "deployment and artifact verification";
  const reused = await deployContracts(options);
  assert.equal(reused.reused, true);
  const { deployment } = reused;
  const registry = deployment.contracts.ParticipantRegistry!;
  const controller = deployment.contracts.MedicalAccessController!;
  const controllerAbi = artifacts.MedicalAccessController.abi;
  const evidence: Record<string, { hash: Hex; block: string; gas: string; status: string }> = {};
  function capture(label: string, receipt: TransactionReceipt, status: "success" | "reverted" = "success") {
    assert.equal(receipt.status, status, label);
    if (status === "reverted") assert.equal(receipt.logs.length, 0, label);
    evidence[label] = { hash: receipt.transactionHash, block: receipt.blockNumber.toString(),
      gas: receipt.gasUsed.toString(), status };
    console.log(label, receipt.status, receipt.gasUsed.toString());
    return receipt;
  }
  for (const [name, hash] of Object.entries(deployment.deploymentTransactions)) {
    capture(`deploy.${name}`, await publicClient.getTransactionReceipt({ hash }));
  }
  step = "funding approved wallets";
  for (const actor of actors) lifecycle("fund", "--address", actor.account.address, "--amount", "1");

  async function write(label: string, signer: typeof admin, target: "registry" | "controller", name: string,
    args: readonly unknown[], status: "success" | "reverted" = "success") {
    step = label;
    const hash = await signer.writeContract({ address: target === "registry" ? registry : controller,
      abi: target === "registry" ? artifacts.ParticipantRegistry.abi : controllerAbi, functionName: name, args, gas: 3_000_000n });
    return capture(label, await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }), status);
  }
  function read(functionName: string, args: readonly unknown[]) {
    return publicClient.readContract({ address: controller, abi: controllerAbi, functionName, args });
  }
  function checkEvent(receipt: TransactionReceipt, name: string, expected: object, index = 0) {
    const log = receipt.logs[index];
    assert.equal(log.address.toLowerCase(), controller.toLowerCase());
    const decoded = decodeEventLog({ abi: controllerAbi, data: log.data, topics: log.topics });
    assert.equal(decoded.eventName, name);
    assert.deepEqual(decoded.args, expected);
  }
  const timestamp = async (receipt: TransactionReceipt) => (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  const id = (label: string) => keccak256(toHex(`release:${controller}:${label}`));
  const issuer = id("issuer"), requester = id("requester");
  const expiry = (await publicClient.getBlock()).timestamp + 10_000n;
  await write("register.issuer", admin, "registry", "registerFacility", [issuer]);
  await write("register.requester", admin, "registry", "registerFacility", [requester]);
  for (const [actor, role, facility] of [[patient, "PATIENT", issuer], [clinician, "CLINICIAN", requester],
    [gateway, "GATEWAY", issuer], [oracle, "ORACLE", requester], [auditor, "AUDITOR", issuer]] as const) {
    await write(`register.${role}`, admin, "registry", "registerParticipant",
      [actor.account.address, keccak256(toHex(`${role}_ROLE`)), facility, expiry]);
  }
  const records = Array.from({ length: 20 }, (_, i) => id(`record.${i}`)).sort();
  for (const [index, record] of records.entries()) {
    await write(`record.${index}`, gateway, "controller", "registerRecord", [record, patient.account.address, id(`ciphertext.${index}`), 1]);
  }
  async function authorize(label: string, mode: number, grantId: bigint, expected: boolean) {
    const args = [clinician.account.address, records[0], mode, grantId] as const;
    assert.equal(await read("canRead", args), expected, label);
    const accessId = id(label);
    const receipt = await write(label, gateway, "controller", "authorizeAccess", [...args, accessId], expected ? "success" : "reverted");
    if (expected) checkEvent(receipt, "AccessAuthorized", { accessId, recordId: records[0], patient: patient.account.address,
      clinician: clinician.account.address, gateway: gateway.account.address, mode, grantId, timestamp: await timestamp(receipt) });
  }
  await write("consent.grant", patient, "controller", "grantConsent", [clinician.account.address, records[0], expiry]);
  await authorize("consent.authorize", 0, 1n, true);
  await write("consent.revoke", patient, "controller", "revokeConsent", [1n]);
  await authorize("consent.deniedAfterRevocation", 0, 1n, false);

  for (const [count, requestId] of [[1, 1n], [20, 2n], [1, 3n]] as const) {
    const scope = records.slice(0, count);
    const encounterId = id(`encounter.${requestId}`), evidenceCommitment = id(`evidence.${requestId}`);
    const receipt = await write(`emergency.request.${requestId}`, clinician, "controller", "requestEmergency",
      [patient.account.address, scope, encounterId, 1, evidenceCommitment, 240n]);
    const decisionDeadline = await timestamp(receipt) + 120n;
    const requestHash = hashEmergencyRequest({ chainId: BigInt(chainId), controller, requestId, patient: patient.account.address,
      clinician: clinician.account.address, requesterFacilityId: requester, encounterId, recordIds: scope,
      reasonCode: 1, evidenceCommitment, requestedDuration: 240n, decisionDeadline });
    checkEvent(receipt, "EmergencyRequested", { requestId, patient: patient.account.address, clinician: clinician.account.address,
      facilityId: requester, requestHash, deadline: decisionDeadline });
    assert.deepEqual(await read("getRequestRecords", [requestId]), scope);
    if (requestId === 1n) await authorize("emergency.deniedPending", 1, requestId, false);
    const observedAt = (await publicClient.getBlock()).timestamp, validUntil = observedAt + 60n;
    const approved = requestId !== 3n;
    const resolved = await write(`emergency.resolve.${requestId}`, oracle, "controller", "resolveEmergency",
      [requestId, approved, requestHash, observedAt, validUntil]);
    const activatedAt = approved ? await timestamp(resolved) : 0n;
    const attestationHash = hashEmergencyAttestation({ chainId: BigInt(chainId), controller, requestId, requestHash, approved, observedAt, validUntil });
    checkEvent(resolved, "EmergencyResolved", { requestId, approved, oracle: oracle.account.address,
      attestationHash, activatedAt, expiresAt: approved ? activatedAt + 240n : 0n });
    if (requestId === 1n) {
      await authorize("emergency.authorize", 1, requestId, true);
      const closed = await write("emergency.close", patient, "controller", "closeEmergency", [requestId, 1]);
      checkEvent(closed, "EmergencyClosed", { requestId, actor: patient.account.address, closureCode: 1, timestamp: await timestamp(closed) });
      await authorize("emergency.deniedAfterClosure", 1, requestId, false);
    } else if (requestId === 2n) {
      const reportCommitment = id("review");
      const review = await write("emergency.misuseReview", auditor, "controller", "submitReview", [requestId, 1, reportCommitment]);
      const reviewedAt = await timestamp(review);
      checkEvent(review, "EmergencyClosed", { requestId, actor: auditor.account.address, closureCode: 65535, timestamp: reviewedAt });
      checkEvent(review, "EmergencyReviewed", { requestId, auditor: auditor.account.address, verdict: 1, reportCommitment, timestamp: reviewedAt }, 1);
      await authorize("emergency.deniedAfterMisuse", 1, requestId, false);
    } else {
      await authorize("emergency.deniedAfterRejection", 1, requestId, false);
    }
  }
  await write("record.deactivate", gateway, "controller", "deactivateRecord", [records[0]]);
  const runtimeBytes = (code: Hex | undefined) => {
    assert.ok(code && code.length > 2);
    const size = (code.length - 2) / 2;
    assert.ok(size <= 24_576);
    return size;
  };
  step = "runtime size and evidence";
  const report = { environment: { chainId, client: await publicClient.request({ method: "web3_clientVersion" }),
    node: process.version, platform: process.platform, compiler: "0.8.28", evmTarget: "paris", optimizerRuns: 200 },
    deployment, runtimeBytes: { ParticipantRegistry: runtimeBytes(await publicClient.getCode({ address: registry })),
      MedicalAccessController: runtimeBytes(await publicClient.getCode({ address: controller })) }, receipts: evidence };
  const output = join(root, "infrastructure", ".runtime", "contract-release.json");
  await writeJson(output, report);
  console.log("Contract release verification passed. Evidence written to infrastructure/.runtime/contract-release.json.");
}

verify().catch((error: unknown) => {
  // Never log wallet objects, signed transaction data, or nested RPC diagnostics.
  const details = error instanceof assert.AssertionError || error instanceof DeploymentError
    ? error.message : error instanceof Error ? error.name : "unknown error";
  console.error(`Contract release verification failed at ${step}: ${details}`);
  process.exitCode = 1;
});
