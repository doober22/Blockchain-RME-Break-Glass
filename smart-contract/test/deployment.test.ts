import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import hre from "hardhat";
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readArtifacts } from "../scripts/artifacts.ts";
import { deployContracts } from "../scripts/deployment.ts";

async function fixture(t: TestContext, chainId = 1337, throwOnTransactionFailures = true) {
  const connection = await hre.network.create({ network: "local", override: { chainId, throwOnTransactionFailures } });
  const directory = await mkdtemp(join(tmpdir(), "rme-step02-"));
  t.after(async () => {
    await connection.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const account = privateKeyToAccount(generatePrivateKey());
  await connection.provider.request({ method: "hardhat_setBalance", params: [account.address, toHex(10n ** 20n)] });
  const chain = defineChain({
    id: chainId, name: "Step 02 test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://unused.invalid"] } },
  });
  const transport = custom(connection.provider);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, account, transport });
  const options = {
    publicClient, walletClient, artifacts: await readArtifacts(),
    deploymentsDirectory: join(directory, "deployments"), abiDirectory: join(directory, "abi"),
  };
  const output = join(options.deploymentsDirectory, "1337.json");
  return { options, output, account, connection };
}

test("deploys both contracts and exports matching public metadata/ABIs", async (t) => {
  const { options, output, account } = await fixture(t);
  const { deployment, reused } = await deployContracts(options);
  assert.equal(reused, false);
  assert.equal(deployment.chainId, 1337);
  assert.equal(deployment.initialAdmin, account.address);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), deployment);
  for (const name of ["ParticipantRegistry", "MedicalAccessController"] as const) {
    assert.deepEqual(JSON.parse(await readFile(join(options.abiDirectory, `${name}.json`), "utf8")), options.artifacts[name].abi);
    assert.ok((await options.publicClient.getCode({ address: deployment.contracts[name]! }))?.length);
    assert.equal((await options.publicClient.getTransactionReceipt({ hash: deployment.deploymentTransactions[name]! })).status, "success");
  }
  assert.equal(await options.publicClient.readContract({
    address: deployment.contracts.ParticipantRegistry!, abi: options.artifacts.ParticipantRegistry.abi,
    functionName: "hasRole", args: [`0x${"0".repeat(64)}`, account.address],
  }), true);
});

test("signed normal-consent flow records authorization and rejects reads after revocation", async (t) => {
  // Return mined failure receipts for this scenario instead of throwing on reverted submissions.
  const { options, connection } = await fixture(t, 1337, false);
  const { deployment } = await deployContracts(options);
  const { publicClient, walletClient, artifacts } = options;
  const accounts = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()));
  for (const account of accounts) {
    await connection.provider.request({ method: "hardhat_setBalance", params: [account.address, toHex(10n ** 20n)] });
  }
  const [patient, clinician, gateway] = accounts.map((account) => createWalletClient({
    chain: walletClient.chain, account, transport: custom(connection.provider),
  }));
  const registryAddress = deployment.contracts.ParticipantRegistry!;
  const controllerAddress = deployment.contracts.MedicalAccessController!;
  const now = (await publicClient.getBlock()).timestamp;
  const facility = keccak256(toHex("synthetic-facility"));
  const record = keccak256(toHex("synthetic-record"));
  const ciphertextHash = keccak256(toHex("synthetic-ciphertext"));
  const accessId = keccak256(toHex("synthetic-read"));
  const failedAccessId = keccak256(toHex("synthetic-revoked-read"));
  const expiry = now + 3_600n;

  async function write(
    client: typeof walletClient, name: "ParticipantRegistry" | "MedicalAccessController",
    functionName: string, args: readonly unknown[],
  ) {
    const hash = await client.writeContract({
      address: deployment.contracts[name]!, abi: artifacts[name].abi, functionName, args, gas: 3_000_000n,
    });
    return publicClient.waitForTransactionReceipt({ hash });
  }
  async function read(functionName: string, args: readonly unknown[]) {
    return publicClient.readContract({ address: controllerAddress, abi: artifacts.MedicalAccessController.abi, functionName, args });
  }

  assert.equal((await write(walletClient, "ParticipantRegistry", "registerFacility", [facility])).status, "success");
  for (const [client, role] of [[patient, "PATIENT_ROLE"], [clinician, "CLINICIAN_ROLE"], [gateway, "GATEWAY_ROLE"]] as const) {
    assert.equal((await write(walletClient, "ParticipantRegistry", "registerParticipant", [
      client.account.address, keccak256(toHex(role)), facility, expiry,
    ])).status, "success");
  }
  assert.ok(await publicClient.getCode({ address: registryAddress }));
  assert.equal((await write(gateway, "MedicalAccessController", "registerRecord", [record, patient.account.address, ciphertextHash, 1])).status, "success");
  assert.equal((await write(patient, "MedicalAccessController", "grantConsent", [clinician.account.address, record, expiry])).status, "success");
  const readArgs = [clinician.account.address, record, 0, 1n] as const;
  assert.equal(await read("canRead", readArgs), true);
  const authorized = await write(gateway, "MedicalAccessController", "authorizeAccess", [...readArgs, accessId]);
  assert.equal(authorized.status, "success");
  const log = authorized.logs.find((entry) => entry.address.toLowerCase() === controllerAddress.toLowerCase());
  assert.ok(log);
  const decoded = decodeEventLog({ abi: artifacts.MedicalAccessController.abi, data: log.data, topics: log.topics });
  assert.equal(decoded.eventName, "AccessAuthorized");
  assert.deepEqual(decoded.args, {
    accessId, recordId: record, patient: patient.account.address, clinician: clinician.account.address,
    gateway: gateway.account.address, mode: 0, grantId: 1n,
    timestamp: (await publicClient.getBlock({ blockNumber: authorized.blockNumber })).timestamp,
  });

  assert.equal((await write(patient, "MedicalAccessController", "revokeConsent", [1n])).status, "success");
  assert.equal(await read("canRead", readArgs), false);
  // Explicit gas sends the failing transaction rather than stopping at gas estimation.
  const denied = await write(gateway, "MedicalAccessController", "authorizeAccess", [...readArgs, failedAccessId]);
  assert.equal(denied.status, "reverted");
  assert.equal(denied.logs.length, 0);
  const oldConsent = await read("getConsent", [1n]) as { exists: boolean; revoked: boolean };
  assert.equal(oldConsent.exists, true);
  assert.equal(oldConsent.revoked, true);
  assert.equal((await write(patient, "MedicalAccessController", "grantConsent", [clinician.account.address, record, expiry])).status, "success");
  assert.equal((await write(gateway, "MedicalAccessController", "authorizeAccess", [clinician.account.address, record, 0, 2n, failedAccessId])).status, "success");
});

test("second deployment verifies/reuses addresses without submitting transactions", async (t) => {
  const { options, account } = await fixture(t);
  const first = await deployContracts(options);
  const nonce = await options.publicClient.getTransactionCount({ address: account.address });
  const second = await deployContracts(options);
  assert.equal(second.reused, true);
  assert.deepEqual(second.deployment, first.deployment);
  assert.equal(await options.publicClient.getTransactionCount({ address: account.address }), nonce);
});

test("rejects an RPC on the wrong chain before sending a transaction", async (t) => {
  const { options, account } = await fixture(t, 31337);
  await assert.rejects(deployContracts(options), /chain ID must be 1337/);
  assert.equal(await options.publicClient.getTransactionCount({ address: account.address }), 0);
});

test("rejects changed compiler artifacts; explicit redeploy creates new addresses", async (t) => {
  const { options, output, account } = await fixture(t);
  const first = await deployContracts(options);
  const saved = JSON.parse(await readFile(output, "utf8"));
  saved.artifactHashes.ParticipantRegistry = keccak256("0x1234");
  await writeFile(output, JSON.stringify(saved));
  await assert.rejects(deployContracts(options), /configuration changed/);
  assert.equal(await options.publicClient.getTransactionCount({ address: account.address }), 2);
  const second = await deployContracts({ ...options, redeploy: true });
  assert.notEqual(second.deployment.contracts.ParticipantRegistry, first.deployment.contracts.ParticipantRegistry);
  assert.equal(await options.publicClient.getTransactionCount({ address: account.address }), 4);
});

test("rejects existing addresses whose code disappeared after a chain reset", async (t) => {
  const { options, connection } = await fixture(t);
  const { deployment } = await deployContracts(options);
  await connection.provider.request({ method: "hardhat_setCode", params: [deployment.contracts.ParticipantRegistry!, "0x"] });
  await assert.rejects(deployContracts(options), /bytecode is missing or changed/);
});

test("resumes a pending transaction receipt without deploying duplicates", async (t) => {
  const { options, output, account } = await fixture(t);
  const first = await deployContracts(options);
  const progress = structuredClone(first.deployment);
  delete progress.contracts.MedicalAccessController;
  await writeFile(join(options.deploymentsDirectory, "1337.pending.json"), JSON.stringify(progress));
  await unlink(output);
  const second = await deployContracts(options);
  assert.deepEqual(second.deployment, first.deployment);
  assert.equal(await options.publicClient.getTransactionCount({ address: account.address }), 2);
});

test("rejects substituted deployment transactions and malformed metadata", async (t) => {
  const { options, output } = await fixture(t);
  const { deployment } = await deployContracts(options);
  const corrupted = structuredClone(deployment);
  corrupted.deploymentTransactions.ParticipantRegistry = corrupted.deploymentTransactions.MedicalAccessController;
  await writeFile(output, JSON.stringify(corrupted));
  await assert.rejects(deployContracts(options), /deployment transaction does not match/);
  await writeFile(output, "null");
  await assert.rejects(deployContracts(options), /metadata cannot be read/);
});

test("rejects a changed deployer and concurrent deployment lock", async (t) => {
  const { options } = await fixture(t);
  await deployContracts(options);
  const walletClient = createWalletClient({
    chain: options.walletClient.chain, account: privateKeyToAccount(generatePrivateKey()),
    transport: custom({ request: options.publicClient.request }),
  });
  await assert.rejects(deployContracts({ ...options, walletClient }), /configuration changed/);
  await writeFile(join(options.deploymentsDirectory, "1337.lock"), "");
  await assert.rejects(deployContracts(options), /Deployment is locked/);
});
