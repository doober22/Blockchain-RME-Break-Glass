import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parseDeploymentManifest } from "./integration.ts";

const defaultManifestPath = fileURLToPath(new URL("../smart-contract/deployments/1337.json", import.meta.url));
const defaultRegistryAbiPath = fileURLToPath(
  new URL("../smart-contract/abi/ParticipantRegistry.json", import.meta.url),
);
const defaultControllerAbiPath = fileURLToPath(
  new URL("../smart-contract/abi/MedicalAccessController.json", import.meta.url),
);

function renderSkeletonHtml(rpcUrl: string, gatewayUrl: string): string {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RME Break-Glass Access Control — Besu 1337</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; }
    header { border-bottom: 1px solid #cbd5e1; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; background: #f8fafc; }
    .banner-blocked { background: #fef2f2; border-color: #ef4444; color: #991b1b; display: none; }
    .banner-ok { background: #f0fdf4; border-color: #22c55e; color: #166534; display: none; }
    code { background: #e2e8f0; padding: 0.15rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
    button { background: #0f172a; color: #fff; border: none; border-radius: 6px; padding: 0.55rem 1rem; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    dl { display: grid; grid-template-columns: 200px 1fr; row-gap: 0.5rem; margin: 0; }
    dt { font-weight: 600; }
    dd { margin: 0; font-family: monospace; word-break: break-all; }
  </style>
</head>
<body>
  <header>
    <h1>RME Break-Glass Access Control (Chain ID 1337)</h1>
    <p>Prototipe konsorsium RME dengan Patient Consent &amp; Emergency Break-Glass pada Hyperledger Besu QBFT.</p>
  </header>
  <div id="network-blocked" class="card banner-blocked"></div>
  <div id="network-ok" class="card banner-ok"></div>
  <div class="card">
    <button id="connect-wallet" type="button">Hubungkan MetaMask (Chain 1337)</button>
  </div>
  <div class="card">
    <h2>Status Jaringan &amp; Kontrak</h2>
    <dl>
      <dt>RPC Host</dt><dd id="rpc-url">${rpcUrl}</dd>
      <dt>Gateway Host</dt><dd id="gateway-url">${gatewayUrl}</dd>
      <dt>Wallet Account</dt><dd id="wallet-account">Belum terhubung</dd>
      <dt>Wallet Chain ID</dt><dd id="wallet-chain">-</dd>
      <dt>Genesis Hash</dt><dd id="genesis-hash">-</dd>
      <dt>ParticipantRegistry</dt><dd id="registry-address">-</dd>
      <dt>MedicalAccessController</dt><dd id="controller-address">-</dd>
    </dl>
  </div>
  <script type="module">
    const blockedBanner = document.getElementById("network-blocked");
    const okBanner = document.getElementById("network-ok");
    const connectBtn = document.getElementById("connect-wallet");

    function setBlocked(reason) {
      blockedBanner.style.display = "block";
      blockedBanner.textContent = "Akses Diblokir: " + reason;
      okBanner.style.display = "none";
    }

    function setOk(message) {
      blockedBanner.style.display = "none";
      okBanner.style.display = "block";
      okBanner.textContent = message;
    }

    async function loadPublicManifest() {
      const res = await fetch("/deployments/1337.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Gagal memuat manifest deployment 1337.json");
      const manifest = await res.json();
      document.getElementById("genesis-hash").textContent = manifest.genesisHash;
      document.getElementById("registry-address").textContent = manifest.contracts.ParticipantRegistry;
      document.getElementById("controller-address").textContent = manifest.contracts.MedicalAccessController;
      return manifest;
    }

    async function verifyWalletNetwork() {
      const manifest = await loadPublicManifest();
      if (!window.ethereum) {
        setBlocked("MetaMask tidak terdeteksi di browser.");
        return;
      }
      const [chainId, accounts] = await Promise.all([
        window.ethereum.request({ method: "eth_chainId" }),
        window.ethereum.request({ method: "eth_requestAccounts" }),
      ]);
      document.getElementById("wallet-chain").textContent = String(chainId);
      if (chainId !== "0x539" && chainId !== 1337) {
        setBlocked("Jaringan salah (" + chainId + "). Harap pindah ke RME Besu Local (Chain ID 1337 / 0x539).");
        return;
      }
      const account = Array.isArray(accounts) && accounts[0] ? accounts[0] : null;
      if (!account) {
        setBlocked("Tidak ada akun MetaMask yang aktif.");
        return;
      }
      document.getElementById("wallet-account").textContent = account;
      setOk("Terhubung ke RME Besu Local (Chain ID 1337) dengan manifest schemaVersion " + manifest.schemaVersion + ".");
    }

    connectBtn.addEventListener("click", () => {
      verifyWalletNetwork().catch((err) => setBlocked(err.message || "Gagal memverifikasi wallet"));
    });
    loadPublicManifest().catch((err) => setBlocked(err.message));
    if (window.ethereum && window.ethereum.on) {
      window.ethereum.on("chainChanged", () => verifyWalletNetwork().catch((err) => setBlocked(err.message)));
      window.ethereum.on("accountsChanged", () => verifyWalletNetwork().catch((err) => setBlocked(err.message)));
    }
  </script>
</body>
</html>`;
}

function sendResponse(res: ServerResponse, status: number, contentType: string, body: string) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/**
 * Serves only the public frontend skeleton, the verified schemaVersion 1 deployment manifest,
 * and the two public contract ABI JSON files. Never exposes .env or service secrets.
 */
export function createFrontendServer(config?: {
  manifestPath?: string;
  registryAbiPath?: string;
  controllerAbiPath?: string;
  rpcUrl?: string;
  gatewayUrl?: string;
}) {
  const manifestPath = config?.manifestPath ?? defaultManifestPath;
  const registryAbiPath = config?.registryAbiPath ?? defaultRegistryAbiPath;
  const controllerAbiPath = config?.controllerAbiPath ?? defaultControllerAbiPath;
  const rpcUrl = config?.rpcUrl ?? "http://127.0.0.1:8545";
  const gatewayUrl = config?.gatewayUrl ?? "http://127.0.0.1:8080";

  return createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    async (req, res) => {
      if (req.method !== "GET") {
        return sendResponse(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: "method_not_allowed" }));
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return sendResponse(res, 200, "text/html; charset=utf-8", renderSkeletonHtml(rpcUrl, gatewayUrl));
      }
      try {
        if (url.pathname === "/deployments/1337.json") {
          const raw = JSON.parse(await readFile(manifestPath, "utf8"));
          const manifest = parseDeploymentManifest(raw);
          return sendResponse(res, 200, "application/json; charset=utf-8", JSON.stringify(manifest));
        }
        if (url.pathname === "/abi/ParticipantRegistry.json") {
          const abi = JSON.parse(await readFile(registryAbiPath, "utf8"));
          if (!Array.isArray(abi)) throw new Error("Invalid ParticipantRegistry ABI");
          return sendResponse(res, 200, "application/json; charset=utf-8", JSON.stringify(abi));
        }
        if (url.pathname === "/abi/MedicalAccessController.json") {
          const abi = JSON.parse(await readFile(controllerAbiPath, "utf8"));
          if (!Array.isArray(abi)) throw new Error("Invalid MedicalAccessController ABI");
          return sendResponse(res, 200, "application/json; charset=utf-8", JSON.stringify(abi));
        }
      } catch {
        return sendResponse(
          res,
          500,
          "application/json; charset=utf-8",
          JSON.stringify({ error: "public_artifact_unavailable" }),
        );
      }
      return sendResponse(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not_found" }));
    },
  );
}
