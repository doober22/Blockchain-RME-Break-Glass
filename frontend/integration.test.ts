import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BESU_CHAIN_ID,
  BESU_CHAIN_ID_HEX,
  assertBesuChainId,
  createWalletGuard,
  parseDeploymentManifest,
  validateIntegration,
  verifyLiveDeployment,
  type DeploymentManifest,
  type Eip1193Provider,
} from "./integration.ts";
import { createFrontendServer } from "./server.ts";

const bytes32 = (value: number): Hex => toHex(value, { size: 32 });
const CLINICIAN_ROLE = keccak256(toHex("CLINICIAN_ROLE"));
const committedManifestPath = fileURLToPath(new URL("../smart-contract/deployments/1337.json", import.meta.url));

const simulatedAbi = parseAbi([
  "function registry() view returns (address)",
  "function isEligible(address account, bytes32 role) view returns (bool)",
  "function getParticipant(address account) view returns ((bool exists,bytes32 facilityId,bool active,uint64 validUntil))",
]);

function createMockRpcTransport(config: {
  manifest: DeploymentManifest;
  chainIdHex?: string;
  genesisHash?: Hex;
  missingBytecodeFor?: "ParticipantRegistry" | "MedicalAccessController";
  revertedReceiptFor?: "ParticipantRegistry" | "MedicalAccessController";
  wrongRegistryWiring?: boolean;
  eligibleClinician?: Address;
  clinicianFacility?: Hex;
}) {
  const chainIdHex = config.chainIdHex ?? BESU_CHAIN_ID_HEX;
  const genesisHash = config.genesisHash ?? config.manifest.genesisHash;
  const facilityId = config.clinicianFacility ?? bytes32(2);

  return custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return chainIdHex;
      if (method === "eth_getBlockByNumber") {
        const [tag] = params as [string];
        const isGenesis = tag === "0x0";
        return {
          number: isGenesis ? "0x0" : "0x10",
          hash: isGenesis ? genesisHash : bytes32(16),
          parentHash: isGenesis ? bytes32(0) : genesisHash,
          nonce: "0x0000000000000000",
          sha3Uncles: bytes32(0),
          logsBloom: `0x${"00".repeat(256)}`,
          transactionsRoot: bytes32(0),
          stateRoot: bytes32(0),
          receiptsRoot: bytes32(0),
          miner: "0x0000000000000000000000000000000000000000",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          extraData: "0x",
          size: "0x200",
          gasLimit: toHex(30_000_000n),
          gasUsed: "0x0",
          timestamp: toHex(1_700_000_000n),
          transactions: [],
          uncles: [],
          baseFeePerGas: toHex(1_000_000_000n),
        };
      }
      if (method === "eth_getCode") {
        const [addr] = params as [Address];
        const target = getAddress(addr);
        if (
          (config.missingBytecodeFor === "ParticipantRegistry" &&
            target === config.manifest.contracts.ParticipantRegistry) ||
          (config.missingBytecodeFor === "MedicalAccessController" &&
            target === config.manifest.contracts.MedicalAccessController)
        ) {
          return "0x";
        }
        return "0x6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe";
      }
      if (method === "eth_getTransactionReceipt") {
        const [hash] = params as [Hex];
        const lower = hash.toLowerCase();
        const isRegistry = lower === config.manifest.deploymentTransactions.ParticipantRegistry;
        const contractName = isRegistry ? "ParticipantRegistry" : "MedicalAccessController";
        const reverted = config.revertedReceiptFor === contractName;
        return {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: bytes32(1),
          blockNumber: "0x1",
          from: config.manifest.deployer,
          to: null,
          cumulativeGasUsed: toHex(1_000_000n),
          gasUsed: toHex(1_000_000n),
          contractAddress: config.manifest.contracts[contractName],
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: reverted ? "0x0" : "0x1",
          effectiveGasPrice: toHex(1_000_000_000n),
          type: "0x2",
        };
      }
      if (method === "eth_call") {
        const [call] = params as [{ to: Address; data: Hex }];
        const decoded = decodeFunctionData({ abi: simulatedAbi, data: call.data });
        if (decoded.functionName === "registry") {
          const wired = config.wrongRegistryWiring
            ? "0x9999999999999999999999999999999999999999"
            : config.manifest.contracts.ParticipantRegistry;
          return encodeFunctionResult({ abi: simulatedAbi, functionName: "registry", result: wired });
        }
        if (decoded.functionName === "isEligible") {
          const [account, role] = decoded.args as [Address, Hex];
          const ok =
            config.eligibleClinician !== undefined &&
            getAddress(account) === getAddress(config.eligibleClinician) &&
            role.toLowerCase() === CLINICIAN_ROLE.toLowerCase();
          return encodeFunctionResult({ abi: simulatedAbi, functionName: "isEligible", result: ok });
        }
        if (decoded.functionName === "getParticipant") {
          const [account] = decoded.args as [Address];
          const isClinician =
            config.eligibleClinician !== undefined && getAddress(account) === getAddress(config.eligibleClinician);
          return encodeFunctionResult({
            abi: simulatedAbi,
            functionName: "getParticipant",
            result: {
              exists: isClinician,
              facilityId: isClinician ? facilityId : bytes32(0),
              active: isClinician,
              validUntil: isClinician ? 1_700_003_600n : 0n,
            },
          });
        }
      }
      throw new Error(`Unhandled RPC method: ${method}`);
    },
  });
}

test("manifest validator accepts schemaVersion 1 1337.json and rejects legacy or malformed manifests", async () => {
  const rawManifest = JSON.parse(await readFile(committedManifestPath, "utf8"));
  const manifest = validateIntegration(rawManifest, BESU_CHAIN_ID_HEX, BESU_CHAIN_ID);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.chainId, 1337);
  assert.match(manifest.genesisHash, /^0x[0-9a-f]{64}$/);
  assert.match(manifest.deploymentTransactions.ParticipantRegistry, /^0x[0-9a-f]{64}$/);
  assert.match(manifest.deploymentTransactions.MedicalAccessController, /^0x[0-9a-f]{64}$/);

  assert.doesNotThrow(() => assertBesuChainId(1337));
  assert.doesNotThrow(() => assertBesuChainId(1337n));
  assert.doesNotThrow(() => assertBesuChainId("0x539"));
  for (const badChainId of [1, "1337", "0x0539", "0x1", null, undefined, {}]) {
    assert.throws(() => assertBesuChainId(badChainId));
  }

  const invalidManifests: unknown[] = [
    null,
    [],
    { ...rawManifest, schemaVersion: 2 },
    { ...rawManifest, schemaVersion: undefined },
    { ...rawManifest, chainId: 1 },
    { ...rawManifest, genesisHash: "0x1234" },
    { ...rawManifest, deployer: "0x0000000000000000000000000000000000000000" },
    {
      ...rawManifest,
      contracts: {
        ParticipantRegistry: rawManifest.contracts.ParticipantRegistry,
        MedicalAccessController: rawManifest.contracts.ParticipantRegistry,
      },
    },
    {
      ...rawManifest,
      deploymentTransactions: {
        ParticipantRegistry: rawManifest.deploymentTransactions.ParticipantRegistry,
        MedicalAccessController: rawManifest.deploymentTransactions.ParticipantRegistry,
      },
    },
    { ...rawManifest, deploymentTransactions: {} },
    { ...rawManifest, artifactHashes: { ParticipantRegistry: "0x00" } },
  ];
  for (const invalid of invalidManifests) {
    assert.throws(() => parseDeploymentManifest(invalid));
  }
});

test("live deployment verifier checks genesis hash, deployed bytecode, receipts, and registry wiring", async () => {
  const rawManifest = JSON.parse(await readFile(committedManifestPath, "utf8"));
  const manifest = parseDeploymentManifest(rawManifest);

  const verified = await verifyLiveDeployment({
    manifest,
    walletChainId: BESU_CHAIN_ID_HEX,
    transport: createMockRpcTransport({ manifest }),
  });
  assert.equal(verified.rpcChainId, 1337);
  assert.equal(verified.genesisHash, manifest.genesisHash);
  assert.equal(verified.blockNumber, 16n);

  await assert.rejects(
    () =>
      verifyLiveDeployment({
        manifest,
        walletChainId: "0x1",
        transport: createMockRpcTransport({ manifest }),
      }),
    /Expected Besu chain ID 1337/,
  );

  await assert.rejects(
    () =>
      verifyLiveDeployment({
        manifest,
        transport: createMockRpcTransport({ manifest, genesisHash: bytes32(999) }),
      }),
    /genesis hash does not match/i,
  );

  await assert.rejects(
    () =>
      verifyLiveDeployment({
        manifest,
        transport: createMockRpcTransport({ manifest, missingBytecodeFor: "MedicalAccessController" }),
      }),
    /no deployed bytecode/i,
  );

  await assert.rejects(
    () =>
      verifyLiveDeployment({
        manifest,
        transport: createMockRpcTransport({ manifest, revertedReceiptFor: "ParticipantRegistry" }),
      }),
    /deployment receipt does not match/i,
  );

  await assert.rejects(
    () =>
      verifyLiveDeployment({
        manifest,
        transport: createMockRpcTransport({ manifest, wrongRegistryWiring: true }),
      }),
    /registry reference does not match/i,
  );
});

test("wallet guard blocks wrong networks on chainChanged, tracks participant roles, and signs gateway challenges", async (t) => {
  const rawManifest = JSON.parse(await readFile(committedManifestPath, "utf8"));
  const manifest = parseDeploymentManifest(rawManifest);
  const clinicianAccount = privateKeyToAccount(generatePrivateKey());

  let walletChainId = BESU_CHAIN_ID_HEX;
  let walletAccounts: string[] = [clinicianAccount.address];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return walletChainId;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return walletAccounts;
      if (method === "personal_sign") {
        const [message, signer] = params as [string, Address];
        assert.equal(getAddress(signer), clinicianAccount.address);
        return clinicianAccount.signMessage({ message });
      }
      throw new Error(`Unsupported wallet method: ${method}`);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };

  const emit = (event: "chainChanged" | "accountsChanged", payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };

  const guard = createWalletGuard({
    provider,
    manifest,
    transport: createMockRpcTransport({
      manifest,
      eligibleClinician: clinicianAccount.address,
      clinicianFacility: bytes32(2),
    }),
  });
  t.after(() => guard.destroy());

  const connected = await guard.connect();
  assert.equal(connected.account, clinicianAccount.address);
  assert.deepEqual(connected.participant.eligibleRoles, ["CLINICIAN_ROLE"]);
  assert.equal(connected.participant.facilityId, bytes32(2));
  assert.equal(guard.getState().blocked, false);

  // Switching MetaMask to Ethereum Mainnet (0x1) immediately blocks the UI and action guard.
  walletChainId = "0x1";
  emit("chainChanged", "0x1");
  assert.equal(guard.getState().blocked, true);
  await assert.rejects(() => guard.guardBeforeAction(), /Expected Besu chain ID 1337/);

  // Switching back to 0x539 restores access.
  walletChainId = BESU_CHAIN_ID_HEX;
  emit("chainChanged", BESU_CHAIN_ID_HEX);
  assert.equal(guard.getState().blocked, false);
  await assert.doesNotReject(() => guard.guardBeforeAction());

  // Signed gateway challenge & record delivery flow through the wallet guard.
  const expectedAccessId = bytes32(777);
  const expectedPayload = Buffer.from(JSON.stringify({ synthetic: true, clinicalSummary: "wallet-guard-read" }));
  const mockGateway = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/challenge") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          nonce: bytes32(555),
          message: "RME gateway challenge for wallet guard test",
          expiresAt: Date.now() + 30_000,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/records/read") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "X-Access-Id": expectedAccessId,
      });
      res.end(expectedPayload);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  mockGateway.listen(0, "127.0.0.1");
  await once(mockGateway, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => mockGateway.close((err) => (err ? reject(err) : resolve()))));
  const gwAddress = mockGateway.address();
  assert.ok(gwAddress && typeof gwAddress !== "string");

  const readResult = await guard.signGatewayRead({
    gatewayOrigin: `http://127.0.0.1:${gwAddress.port}`,
    recordId: bytes32(10),
    mode: 1,
    grantId: 1n,
  });
  assert.equal(readResult.status, 200);
  assert.equal(readResult.accessId, expectedAccessId);
  assert.deepEqual(Buffer.from(readResult.payload), expectedPayload);

  // Disconnecting accounts blocks actions.
  walletAccounts = [];
  emit("accountsChanged", []);
  assert.equal(guard.getState().blocked, true);
  await assert.rejects(() => guard.guardBeforeAction(), /wallet_disconnected/);
});

test("frontend HTTP server serves only the public skeleton, validated manifest, and ABIs with no-store headers", async (t) => {
  const server = createFrontendServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const indexRes = await fetch(`${baseUrl}/`);
  assert.equal(indexRes.status, 200);
  assert.equal(indexRes.headers.get("cache-control"), "no-store");
  assert.equal(indexRes.headers.get("x-content-type-options"), "nosniff");
  const html = await indexRes.text();
  assert.match(html, /RME Break-Glass Access Control/);

  const manifestRes = await fetch(`${baseUrl}/deployments/1337.json`);
  assert.equal(manifestRes.status, 200);
  const servedManifest = parseDeploymentManifest(await manifestRes.json());
  assert.equal(servedManifest.chainId, 1337);

  for (const abiPath of ["/abi/ParticipantRegistry.json", "/abi/MedicalAccessController.json"]) {
    const abiRes = await fetch(`${baseUrl}${abiPath}`);
    assert.equal(abiRes.status, 200);
    assert.ok(Array.isArray(await abiRes.json()));
  }

  // Non-public paths and non-GET requests are rejected.
  const secretAttempt = await fetch(`${baseUrl}/.env`);
  assert.equal(secretAttempt.status, 404);
  const postAttempt = await fetch(`${baseUrl}/`, { method: "POST" });
  assert.equal(postAttempt.status, 405);
});
