/** Public deployment metadata only. No signers, secrets, or runtime client. */
export const BESU_CHAIN_ID = 1337;
export type Address = `0x${string}`;

export interface DeploymentManifest {
  chainId: typeof BESU_CHAIN_ID;
  contracts: {
    ParticipantRegistry: Address;
    MedicalAccessController: Address;
  };
  // Encoding awaits Role 2's deployment exporter.
  deploymentTransactions: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error("Expected a nonzero EVM deployment address");
  }
  return value as Address;
}

/** Accept numeric IDs or canonical JSON-RPC hex IDs; reject coercible junk. */
export function assertBesuChainId(value: unknown): void {
  if (value === BESU_CHAIN_ID) return;
  if (typeof value === "string" && /^0x[1-9a-fA-F][0-9a-fA-F]*$/.test(value) && BigInt(value) === 1337n) return;
  throw new Error("Expected Besu chain ID 1337 (0x539)");
}

export function parseDeploymentManifest(value: unknown): DeploymentManifest {
  if (!isObject(value) || value.chainId !== BESU_CHAIN_ID || !isObject(value.contracts) ||
      !Object.hasOwn(value, "deploymentTransactions") || value.deploymentTransactions == null) {
    throw new Error("Invalid deployment manifest for chain 1337");
  }
  return {
    chainId: BESU_CHAIN_ID,
    contracts: {
      ParticipantRegistry: readAddress(value.contracts.ParticipantRegistry),
      MedicalAccessController: readAddress(value.contracts.MedicalAccessController),
    },
    deploymentTransactions: value.deploymentTransactions,
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
