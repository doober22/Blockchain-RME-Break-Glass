import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

for (const relative of ["../../.env", "../.env"]) {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  if (existsSync(path)) loadEnvFile(path);
}

export const BESU_CHAIN_ID = 1337;

export function networkSettings() {
  if (process.env.BESU_CHAIN_ID !== undefined && process.env.BESU_CHAIN_ID !== "1337") {
    throw new Error("Step 02 requires BESU_CHAIN_ID=1337.");
  }
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  if (!["http:", "https:"].includes(new URL(rpcUrl).protocol)) {
    throw new Error("BESU_RPC_URL must use HTTP or HTTPS.");
  }
  return { chainId: BESU_CHAIN_ID, rpcUrl };
}
