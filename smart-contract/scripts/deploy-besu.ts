import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { projectRoot, readArtifacts } from "./artifacts.ts";
import { DeploymentError, deployContracts } from "./deployment.ts";
import { networkSettings } from "./environment.ts";

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--redeploy")) throw new DeploymentError("Only --redeploy is supported.");
  const { chainId, rpcUrl } = networkSettings();
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new DeploymentError("Set DEPLOYER_PRIVATE_KEY to a throwaway local account key (0x + 64 hex characters).");
  }
  const account = privateKeyToAccount(key as Hex);
  const chain = defineChain({
    id: chainId, name: "RME Besu Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  const result = await deployContracts({
    publicClient, walletClient, artifacts: await readArtifacts(),
    deploymentsDirectory: join(projectRoot, "deployments"), abiDirectory: join(projectRoot, "abi"),
    redeploy: args.includes("--redeploy"),
  });
  console.log(result.reused ? "Verified and reused deployment:" : "Deployed and verified:");
  console.log(JSON.stringify(result.deployment, null, 2));
} catch (error) {
  console.error(error instanceof DeploymentError ? error.message
    : "Deployment failed. Check RPC, chain ID 1337, deployer key, allowlist/funding, and pending metadata. RPC error details are suppressed to avoid logging credentials.");
  process.exitCode = 1;
}
