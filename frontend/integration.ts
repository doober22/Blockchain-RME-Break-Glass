import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type Transport,
} from "viem";

/** Public deployment metadata and browser-safe wallet/RPC guards only. No private keys or secrets. */
export const BESU_CHAIN_ID = 1337;
export const BESU_CHAIN_ID_HEX = "0x539";
export type Address = `0x${string}`;
export type Hash = `0x${string}`;
export type ContractName = "ParticipantRegistry" | "MedicalAccessController";

export interface DeploymentManifest {
  schemaVersion: 1;
  chainId: typeof BESU_CHAIN_ID;
  genesisHash: Hash;
  deployer: Address;
  initialAdmin: Address;
  artifactHashes: Record<ContractName, Hash>;
  contracts: Record<ContractName, Address>;
  deploymentTransactions: Record<ContractName, Hash>;
}

export interface VerifiedDeployment {
  manifest: DeploymentManifest;
  rpcChainId: typeof BESU_CHAIN_ID;
  genesisHash: Hash;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export type ApplicationRoleName = "PATIENT_ROLE" | "CLINICIAN_ROLE" | "AUDITOR_ROLE" | "ORACLE_ROLE" | "GATEWAY_ROLE";

export interface WalletParticipantStatus {
  account: Address;
  exists: boolean;
  facilityId: Hash;
  active: boolean;
  validUntil: bigint;
  eligibleRoles: ApplicationRoleName[];
}

export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: "chainChanged" | "accountsChanged", listener: (payload: unknown) => void): void;
  removeListener?(event: "chainChanged" | "accountsChanged", listener: (payload: unknown) => void): void;
}

const ROLE_NAMES: readonly ApplicationRoleName[] = [
  "PATIENT_ROLE",
  "CLINICIAN_ROLE",
  "AUDITOR_ROLE",
  "ORACLE_ROLE",
  "GATEWAY_ROLE",
];

const ROLE_HASHES: Record<ApplicationRoleName, Hash> = {
  PATIENT_ROLE: keccak256(toHex("PATIENT_ROLE")),
  CLINICIAN_ROLE: keccak256(toHex("CLINICIAN_ROLE")),
  AUDITOR_ROLE: keccak256(toHex("AUDITOR_ROLE")),
  ORACLE_ROLE: keccak256(toHex("ORACLE_ROLE")),
  GATEWAY_ROLE: keccak256(toHex("GATEWAY_ROLE")),
};

const frontendControllerAbi = parseAbi([
  "function registry() view returns (address)",
]);

const frontendRegistryAbi = parseAbi([
  "function isEligible(address account, bytes32 role) view returns (bool)",
  "function getParticipant(address account) view returns ((bool exists,bytes32 facilityId,bool active,uint64 validUntil))",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAddress(value: unknown, label = "deployment address"): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Expected a nonzero EVM ${label}`);
  }
  const lower = value.toLowerCase();
  if (!isAddress(lower)) {
    throw new Error(`Invalid EVM ${label}`);
  }
  return getAddress(lower);
}

function readBytes32(value: unknown, label: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) {
    throw new Error(`Expected a nonzero bytes32 hash for ${label}`);
  }
  return value.toLowerCase() as Hash;
}

/** Accept numeric IDs or canonical JSON-RPC hex IDs; reject coercible junk. */
export function assertBesuChainId(value: unknown): void {
  if (value === BESU_CHAIN_ID || value === BigInt(BESU_CHAIN_ID)) return;
  if (typeof value === "string" && /^0x[1-9a-fA-F][0-9a-fA-F]*$/.test(value) && BigInt(value) === 1337n) return;
  throw new Error("Expected Besu chain ID 1337 (0x539)");
}

/** Validates the full schemaVersion 1 deployment manifest produced by smart-contract deployment tooling. */
export function parseDeploymentManifest(value: unknown): DeploymentManifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.chainId !== BESU_CHAIN_ID ||
    !isObject(value.contracts) ||
    !isObject(value.deploymentTransactions) ||
    !isObject(value.artifactHashes)
  ) {
    throw new Error("Invalid schemaVersion 1 deployment manifest for chain 1337");
  }

  const genesisHash = readBytes32(value.genesisHash, "genesisHash");
  const deployer = readAddress(value.deployer, "deployer address");
  const initialAdmin = readAddress(value.initialAdmin, "initialAdmin address");
  const registryAddress = readAddress(value.contracts.ParticipantRegistry, "ParticipantRegistry address");
  const controllerAddress = readAddress(value.contracts.MedicalAccessController, "MedicalAccessController address");
  if (registryAddress.toLowerCase() === controllerAddress.toLowerCase()) {
    throw new Error("ParticipantRegistry and MedicalAccessController addresses must be distinct");
  }

  const registryTx = readBytes32(
    value.deploymentTransactions.ParticipantRegistry,
    "deploymentTransactions.ParticipantRegistry",
  );
  const controllerTx = readBytes32(
    value.deploymentTransactions.MedicalAccessController,
    "deploymentTransactions.MedicalAccessController",
  );
  if (registryTx === controllerTx) {
    throw new Error("Deployment transaction hashes must be distinct");
  }

  const registryArtifactHash = readBytes32(
    value.artifactHashes.ParticipantRegistry,
    "artifactHashes.ParticipantRegistry",
  );
  const controllerArtifactHash = readBytes32(
    value.artifactHashes.MedicalAccessController,
    "artifactHashes.MedicalAccessController",
  );

  return {
    schemaVersion: 1,
    chainId: BESU_CHAIN_ID,
    genesisHash,
    deployer,
    initialAdmin,
    artifactHashes: {
      ParticipantRegistry: registryArtifactHash,
      MedicalAccessController: controllerArtifactHash,
    },
    contracts: {
      ParticipantRegistry: registryAddress,
      MedicalAccessController: controllerAddress,
    },
    deploymentTransactions: {
      ParticipantRegistry: registryTx,
      MedicalAccessController: controllerTx,
    },
  };
}

/** Call with live wallet eth_chainId and RPC chain ID before using addresses. */
export function validateIntegration(
  manifest: unknown,
  walletChainId: unknown,
  rpcChainId: unknown,
): DeploymentManifest {
  assertBesuChainId(walletChainId);
  assertBesuChainId(rpcChainId);
  return parseDeploymentManifest(manifest);
}

export function createFrontendPublicClient(rpcUrl = "http://127.0.0.1:8545", customTransport?: Transport) {
  const chain = defineChain({
    id: BESU_CHAIN_ID,
    name: "RME Besu Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = customTransport ?? http(rpcUrl, { timeout: 4_000, retryCount: 0 });
  return createPublicClient({ chain, transport, cacheTime: 0 });
}

/**
 * Verifies the deployment manifest against the live Besu RPC:
 * chain ID 1337, genesis hash, non-empty deployed bytecode, successful deployment receipts,
 * and MedicalAccessController -> ParticipantRegistry wiring.
 */
export async function verifyLiveDeployment(config: {
  manifest: unknown;
  walletChainId?: unknown;
  rpcUrl?: string;
  transport?: Transport;
}): Promise<VerifiedDeployment> {
  if (config.walletChainId !== undefined) {
    assertBesuChainId(config.walletChainId);
  }
  const manifest = parseDeploymentManifest(config.manifest);
  const client = createFrontendPublicClient(config.rpcUrl, config.transport);
  const rpcChainId = await client.getChainId();
  assertBesuChainId(rpcChainId);

  const [genesis, latest] = await Promise.all([
    client.getBlock({ blockNumber: 0n }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  if (!genesis.hash || genesis.hash.toLowerCase() !== manifest.genesisHash) {
    throw new Error("RPC genesis hash does not match the deployment manifest");
  }

  for (const name of ["ParticipantRegistry", "MedicalAccessController"] as const) {
    const address = manifest.contracts[name];
    const txHash = manifest.deploymentTransactions[name];
    const [code, receipt] = await Promise.all([
      client.getCode({ address }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    if (!code || code === "0x" || code.length <= 2) {
      throw new Error(`${name} has no deployed bytecode at ${address}`);
    }
    if (
      receipt.status !== "success" ||
      !receipt.contractAddress ||
      getAddress(receipt.contractAddress) !== address ||
      getAddress(receipt.from) !== manifest.deployer
    ) {
      throw new Error(`${name} deployment receipt does not match manifest metadata`);
    }
  }

  const wiredRegistry = await client.readContract({
    address: manifest.contracts.MedicalAccessController,
    abi: frontendControllerAbi,
    functionName: "registry",
  });
  if (getAddress(wiredRegistry) !== manifest.contracts.ParticipantRegistry) {
    throw new Error("MedicalAccessController registry reference does not match ParticipantRegistry address");
  }

  return {
    manifest,
    rpcChainId: BESU_CHAIN_ID,
    genesisHash: manifest.genesisHash,
    blockNumber: latest.number,
    blockTimestamp: latest.timestamp,
  };
}

/**
 * Manages MetaMask / EIP-1193 wallet connection, chainChanged/accountsChanged guards,
 * participant role inspection, and signed gateway record reads.
 */
export function createWalletGuard(config: {
  provider: Eip1193Provider;
  manifest: unknown;
  rpcUrl?: string;
  transport?: Transport;
  fetchImpl?: typeof fetch;
}) {
  const parsedManifest = parseDeploymentManifest(config.manifest);
  const client = createFrontendPublicClient(config.rpcUrl, config.transport);
  const fetchFn = config.fetchImpl ?? fetch;

  let currentAccount: Address | null = null;
  let currentChainIdHex: string | null = null;
  let networkBlockedReason: string | null = "wallet_not_connected";

  const onChainChanged = (chainId: unknown) => {
    try {
      assertBesuChainId(chainId);
      currentChainIdHex = BESU_CHAIN_ID_HEX;
      if (currentAccount) networkBlockedReason = null;
    } catch (error) {
      currentChainIdHex = typeof chainId === "string" ? chainId : String(chainId);
      networkBlockedReason = error instanceof Error ? error.message : "wrong_network";
    }
  };

  const onAccountsChanged = (accounts: unknown) => {
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== "string") {
      currentAccount = null;
      networkBlockedReason = "wallet_disconnected";
      return;
    }
    try {
      currentAccount = readAddress(accounts[0], "wallet account");
      if (currentChainIdHex === BESU_CHAIN_ID_HEX) {
        networkBlockedReason = null;
      }
    } catch {
      currentAccount = null;
      networkBlockedReason = "invalid_wallet_account";
    }
  };

  config.provider.on?.("chainChanged", onChainChanged);
  config.provider.on?.("accountsChanged", onAccountsChanged);

  async function guardBeforeAction(): Promise<{ account: Address; verified: VerifiedDeployment }> {
    const [walletChainId, accounts] = await Promise.all([
      config.provider.request({ method: "eth_chainId" }),
      config.provider.request({ method: "eth_accounts" }),
    ]);
    onChainChanged(walletChainId);
    onAccountsChanged(accounts);
    if (networkBlockedReason || !currentAccount) {
      throw new Error(networkBlockedReason ?? "Wallet is not connected to Besu chain 1337");
    }
    const verified = await verifyLiveDeployment({
      manifest: parsedManifest,
      walletChainId,
      rpcUrl: config.rpcUrl,
      transport: config.transport,
    });
    return { account: currentAccount, verified };
  }

  async function readParticipantStatus(account: Address): Promise<WalletParticipantStatus> {
    const [participant, eligibilityFlags] = await Promise.all([
      client.readContract({
        address: parsedManifest.contracts.ParticipantRegistry,
        abi: frontendRegistryAbi,
        functionName: "getParticipant",
        args: [account],
      }),
      Promise.all(
        ROLE_NAMES.map((role) =>
          client.readContract({
            address: parsedManifest.contracts.ParticipantRegistry,
            abi: frontendRegistryAbi,
            functionName: "isEligible",
            args: [account, ROLE_HASHES[role]],
          }),
        ),
      ),
    ]);
    const eligibleRoles = ROLE_NAMES.filter((_, idx) => eligibilityFlags[idx]);
    return {
      account,
      exists: participant.exists,
      facilityId: participant.facilityId.toLowerCase() as Hash,
      active: participant.active,
      validUntil: participant.validUntil,
      eligibleRoles,
    };
  }

  return {
    getState() {
      return {
        connectedAccount: currentAccount,
        walletChainId: currentChainIdHex,
        blocked: networkBlockedReason !== null,
        blockedReason: networkBlockedReason,
        contracts: parsedManifest.contracts,
      };
    },
    guardBeforeAction,
    async connect(): Promise<{
      account: Address;
      verified: VerifiedDeployment;
      participant: WalletParticipantStatus;
    }> {
      const requested = await config.provider.request({ method: "eth_requestAccounts" });
      onAccountsChanged(requested);
      const { account, verified } = await guardBeforeAction();
      const participant = await readParticipantStatus(account);
      return { account, verified, participant };
    },
    async signGatewayRead(input: {
      gatewayOrigin: string;
      recordId: Hash;
      mode: 0 | 1;
      grantId: bigint;
    }): Promise<{ status: number; accessId: Hash; payload: Uint8Array }> {
      const { account } = await guardBeforeAction();
      const recordId = readBytes32(input.recordId, "recordId");
      if (typeof input.grantId !== "bigint" || input.grantId <= 0n) {
        throw new Error("Expected a positive grantId bigint");
      }
      const origin = new URL(input.gatewayOrigin).origin;
      const challengeRes = await fetchFn(`${origin}/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinician: account,
          recordId,
          mode: input.mode,
          grantId: input.grantId.toString(),
        }),
      });
      if (challengeRes.status !== 201) {
        const errBody = (await challengeRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(`Gateway challenge rejected (${challengeRes.status}): ${errBody.error ?? "unknown"}`);
      }
      const { nonce, message } = (await challengeRes.json()) as { nonce: Hash; message: string };

      // Re-verify wallet network before signing the challenge.
      await guardBeforeAction();
      const signature = await config.provider.request({
        method: "personal_sign",
        params: [message, account],
      });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error("Wallet did not return a valid 65-byte signature");
      }

      const readRes = await fetchFn(`${origin}/records/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, signature }),
      });
      if (readRes.status !== 200) {
        const errBody = (await readRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(`Gateway read rejected (${readRes.status}): ${errBody.error ?? "unknown"}`);
      }
      const accessId = readBytes32(readRes.headers.get("x-access-id"), "X-Access-Id");
      const payload = new Uint8Array(await readRes.arrayBuffer());
      return { status: readRes.status, accessId, payload };
    },
    destroy() {
      config.provider.removeListener?.("chainChanged", onChainChanged);
      config.provider.removeListener?.("accountsChanged", onAccountsChanged);
    },
  };
}
