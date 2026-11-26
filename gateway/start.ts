import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { connectGateway } from "./chain.ts";
import { createGateway } from "./http.ts";
import { recordStore } from "./records.ts";

const runtime = fileURLToPath(new URL("./.runtime/", import.meta.url));
const manifestFile = new URL("../smart-contract/deployments/1337.json", import.meta.url);

export async function loadDeployment() {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.chainId !== 1337
      || !/^0x[0-9a-fA-F]{64}$/.test(manifest.genesisHash)) throw new Error("Invalid deployment manifest");
  return { controller: getAddress(manifest.contracts.MedicalAccessController),
    registry: getAddress(manifest.contracts.ParticipantRegistry), genesisHash: manifest.genesisHash as Hex };
}

export async function startGateway() {
  const privateKey = process.env.GATEWAY_PRIVATE_KEY;
  const recordKey = process.env.GATEWAY_RECORD_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)
      || !recordKey || !/^[0-9a-fA-F]{64}$/.test(recordKey)) throw new Error("Missing gateway keys");
  const port = Number(process.env.GATEWAY_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid gateway port");
  const rpcUrl = process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545";
  if (!["http://127.0.0.1:8545", "http://localhost:8545"].includes(rpcUrl)) throw new Error("Expected local Besu RPC");
  const account = privateKeyToAccount(privateKey as Hex);
  const deployment = await loadDeployment();
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const origin = `http://127.0.0.1:${port}`;
  const server = createGateway({
    chain: await connectGateway({ ...deployment, rpcUrl, account }),
    store: recordStore(join(runtime, "records"), Buffer.from(recordKey, "hex")),
    auditPath: join(runtime, "delivery.jsonl"), gateway: account.address, controller: deployment.controller, origin: () => origin,
  });
  server.on("error", () => {
    console.error("Gateway listener failed");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Gateway listening on ${origin}`));
}
