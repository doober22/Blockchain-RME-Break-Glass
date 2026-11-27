import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseDeploymentManifest, verifyLiveDeployment } from "./integration.ts";
import { createFrontendServer } from "./server.ts";

const manifestFile = fileURLToPath(new URL("../smart-contract/deployments/1337.json", import.meta.url));

export async function startFrontend() {
  const port = Number(process.env.FRONTEND_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid FRONTEND_PORT");
  }
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  if (!["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl)) {
    throw new Error("Expected local Besu RPC");
  }
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";
  const manifest = parseDeploymentManifest(JSON.parse(await readFile(manifestFile, "utf8")));

  if (process.env.FRONTEND_SKIP_RPC_VERIFY !== "1") {
    await verifyLiveDeployment({ manifest, rpcUrl });
  }

  const server = createFrontendServer({ rpcUrl, gatewayUrl });
  server.on("error", () => {
    console.error("Frontend listener failed");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Frontend listening on http://127.0.0.1:${port}`);
  });
  return server;
}
