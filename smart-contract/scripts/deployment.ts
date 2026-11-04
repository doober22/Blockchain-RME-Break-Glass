import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeDeployData, getAddress, isAddress, isHash, keccak256,
  type Address, type Hash, type Hex, type PublicClient, type WalletClient,
} from "viem";
import {
  contractNames, exportAbis, writeJson,
  type ContractArtifact, type ContractArtifacts, type ContractName,
} from "./artifacts.ts";
import { BESU_CHAIN_ID } from "./environment.ts";

export class DeploymentError extends Error {}

export type Deployment = {
  schemaVersion: 1;
  chainId: number;
  genesisHash: Hash;
  deployer: Address;
  initialAdmin: Address;
  artifactHashes: Record<ContractName, Hash>;
  contracts: Partial<Record<ContractName, Address>>;
  deploymentTransactions: Partial<Record<ContractName, Hash>>;
};

type Options = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  artifacts: ContractArtifacts;
  deploymentsDirectory: string;
  abiDirectory: string;
  redeploy?: boolean;
};

async function readDeployment(path: string): Promise<Deployment | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DeploymentError("Invalid deployment metadata.");
    }
    return parsed as Deployment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DeploymentError("Deployment metadata cannot be read; inspect it or explicitly use --redeploy.");
  }
}

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function normalizedCode(code: Hex, artifact: ContractArtifact) {
  let result = code.slice(2).toLowerCase();
  for (const references of Object.values(artifact.immutableReferences ?? {})) {
    for (const { start, length } of references) {
      result = result.slice(0, start * 2) + "0".repeat(length * 2) + result.slice((start + length) * 2);
    }
  }
  return result;
}

function checkConfiguration(saved: Deployment, expected: Deployment) {
  if (
    saved.schemaVersion !== 1 || saved.chainId !== expected.chainId
    || saved.genesisHash !== expected.genesisHash
    || !isAddress(saved.deployer ?? "") || !sameAddress(saved.deployer, expected.deployer)
    || !isAddress(saved.initialAdmin ?? "") || !sameAddress(saved.initialAdmin, expected.initialAdmin)
    || !saved.contracts || !saved.deploymentTransactions
    || contractNames.some((name) => saved.artifactHashes?.[name] !== expected.artifactHashes[name])
  ) throw new DeploymentError("Deployment configuration changed; inspect the metadata and explicitly use --redeploy.");
}

function constructorArgs(name: ContractName, deployment: Deployment) {
  return [name === "ParticipantRegistry" ? deployment.initialAdmin : deployment.contracts.ParticipantRegistry!];
}

async function verifyContract(name: ContractName, deployment: Deployment, options: Options) {
  const address = deployment.contracts[name];
  const hash = deployment.deploymentTransactions[name];
  if (!address || !isAddress(address) || !hash || !isHash(hash)) {
    throw new DeploymentError(`Incomplete ${name} metadata; inspect it or explicitly use --redeploy.`);
  }
  const artifact = options.artifacts[name];
  const code = await options.publicClient.getCode({ address });
  if (!code || code === "0x" || code.length !== artifact.deployedBytecode.length
    || normalizedCode(code, artifact) !== normalizedCode(artifact.deployedBytecode, artifact)) {
    throw new DeploymentError(`${name} bytecode is missing or changed; explicitly use --redeploy after a chain reset or rebuild.`);
  }
  const receipt = await options.publicClient.getTransactionReceipt({ hash });
  const transaction = await options.publicClient.getTransaction({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress || !sameAddress(receipt.contractAddress, address)
    || !sameAddress(transaction.from, deployment.deployer) || transaction.to !== null
    || transaction.input.toLowerCase() !== encodeDeployData({
      abi: artifact.abi, bytecode: artifact.bytecode, args: constructorArgs(name, deployment),
    }).toLowerCase()) {
    throw new DeploymentError(`${name} deployment transaction does not match the configuration.`);
  }
  if (name === "MedicalAccessController") {
    const registry = await options.publicClient.readContract({ address, abi: artifact.abi, functionName: "registry" });
    if (typeof registry !== "string" || !sameAddress(registry, deployment.contracts.ParticipantRegistry!)) {
      throw new DeploymentError("Controller registry reference does not match the deployment.");
    }
  }
}

export async function deployContracts(options: Options): Promise<{ deployment: Deployment; reused: boolean }> {
  const { publicClient, walletClient, artifacts } = options;
  if (await publicClient.getChainId() !== BESU_CHAIN_ID) {
    throw new DeploymentError("RPC chain ID must be 1337; no deployment was submitted.");
  }
  if (!walletClient.account) throw new DeploymentError("A deployment signer is required.");
  const deployer = getAddress(walletClient.account.address);
  const genesis = await publicClient.getBlock({ blockNumber: 0n });
  if (!genesis.hash) throw new DeploymentError("RPC did not return a genesis block hash.");
  const expected: Deployment = {
    schemaVersion: 1, chainId: BESU_CHAIN_ID, genesisHash: genesis.hash,
    deployer, initialAdmin: deployer,
    artifactHashes: {
      ParticipantRegistry: keccak256(artifacts.ParticipantRegistry.bytecode),
      MedicalAccessController: keccak256(artifacts.MedicalAccessController.bytecode),
    },
    contracts: {}, deploymentTransactions: {},
  };

  await mkdir(options.deploymentsDirectory, { recursive: true });
  const output = join(options.deploymentsDirectory, "1337.json");
  const pending = join(options.deploymentsDirectory, "1337.pending.json");
  const lockPath = join(options.deploymentsDirectory, "1337.lock");
  const lock = await open(lockPath, "wx").catch(() => {
    throw new DeploymentError("Deployment is locked. Wait for the other process; remove a stale 1337.lock only after confirming it stopped.");
  });

  try {
    const progress = options.redeploy ? undefined : await readDeployment(pending);
    const completed = options.redeploy || progress ? undefined : await readDeployment(output);
    if (completed) {
      checkConfiguration(completed, expected);
      for (const name of contractNames) await verifyContract(name, completed, options);
      await exportAbis(artifacts, options.abiDirectory);
      return { deployment: completed, reused: true };
    }

    const deployment = progress ?? expected;
    checkConfiguration(deployment, expected);
    if (deployment.contracts.MedicalAccessController && !deployment.contracts.ParticipantRegistry) {
      throw new DeploymentError("Pending deployment has a controller without a registry; inspect it or explicitly use --redeploy.");
    }
    await writeJson(pending, deployment);
    for (const name of contractNames) {
      if (deployment.contracts[name]) {
        await verifyContract(name, deployment, options);
        continue;
      }
      if (deployment.deploymentTransactions[name]) {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: deployment.deploymentTransactions[name], timeout: 60_000,
        });
        if (receipt.status !== "success" || !receipt.contractAddress) {
          throw new DeploymentError(`${name} deployment reverted; inspect pending metadata and explicitly use --redeploy.`);
        }
        deployment.contracts[name] = receipt.contractAddress;
      } else {
        const hash = await walletClient.deployContract({
          account: walletClient.account, chain: walletClient.chain,
          abi: artifacts[name].abi, bytecode: artifacts[name].bytecode,
          args: constructorArgs(name, deployment),
        });
        deployment.deploymentTransactions[name] = hash;
        await writeJson(pending, deployment);
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt.status !== "success" || !receipt.contractAddress) {
          throw new DeploymentError(`${name} deployment reverted; inspect pending metadata and explicitly use --redeploy.`);
        }
        deployment.contracts[name] = receipt.contractAddress;
      }
      await writeJson(pending, deployment);
      await verifyContract(name, deployment, options);
    }
    await exportAbis(artifacts, options.abiDirectory);
    await writeJson(output, deployment);
    await unlink(pending).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { deployment, reused: false };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
