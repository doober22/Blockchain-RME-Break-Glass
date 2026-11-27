import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connectOracle, createOracleWorker } from "./worker.ts";

const runtime = fileURLToPath(new URL("./.runtime/", import.meta.url));
const manifestFile = new URL("../smart-contract/deployments/1337.json", import.meta.url);

export async function loadOracleDeployment() {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.chainId !== 1337 ||
    !/^0x[0-9a-fA-F]{64}$/.test(manifest.genesisHash)
  ) {
    throw new Error("Invalid deployment manifest");
  }
  return {
    controller: getAddress(manifest.contracts.MedicalAccessController),
    registry: getAddress(manifest.contracts.ParticipantRegistry),
    genesisHash: manifest.genesisHash.toLowerCase() as Hex,
  };
}

export async function startOracle() {
  const privateKey = process.env.ORACLE_PRIVATE_KEY;
  const apiBaseUrl = process.env.ORACLE_API_BASE_URL;
  const serviceToken = process.env.ORACLE_SERVICE_TOKEN;
  if (
    !privateKey ||
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    !apiBaseUrl ||
    !serviceToken ||
    serviceToken.trim().length < 16
  ) {
    throw new Error("Missing oracle private key, facility API base URL, or service token");
  }
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  if (!["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl)) {
    throw new Error("Expected local Besu RPC");
  }
  const pollIntervalMs = Number(process.env.ORACLE_POLL_INTERVAL_MS ?? 2_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new Error("Invalid ORACLE_POLL_INTERVAL_MS");
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const deployment = await loadOracleDeployment();
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const chain = await connectOracle({ ...deployment, rpcUrl, account });
  const worker = createOracleWorker({
    chain,
    apiBaseUrl,
    serviceToken,
    checkpointPath: join(runtime, "checkpoint.json"),
    auditPath: join(runtime, "decisions.jsonl"),
  });

  await worker.syncOnce();
  console.log(`Oracle worker active for facility ${chain.facilityId} as ${chain.oracleAddress}`);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.syncOnce();
    } catch {
      console.error("Oracle worker sync cycle failed");
    } finally {
      running = false;
    }
  }, pollIntervalMs);

  const stop = () => {
    clearInterval(timer);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { worker, stop };
}
