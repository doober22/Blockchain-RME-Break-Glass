import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import hre from "hardhat";
import { createPublicClient, createWalletClient, custom, defineChain, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readArtifacts } from "../scripts/artifacts.ts";
import { deployContracts } from "../scripts/deployment.ts";

async function fixture(t: TestContext, chainId = 1337) {
  const connection = await hre.network.create({ network: "local", override: { chainId } });
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
