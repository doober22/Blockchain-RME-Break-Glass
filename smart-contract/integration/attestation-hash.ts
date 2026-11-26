import { encodeAbiParameters, isAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

export const attestationHashParameters = parseAbiParameters(
  "uint256 chainId, address controller, uint256 requestId, bytes32 requestHash, bool approved, uint64 observedAt, uint64 validUntil",
);

export interface AttestationHashInput {
  chainId: bigint;
  controller: Address;
  requestId: bigint;
  requestHash: Hex;
  approved: boolean;
  observedAt: bigint;
  validUntil: bigint;
}

/** Hashes decision fields, not a second signature. Chain-time freshness is enforced on-chain. */
export function hashEmergencyAttestation(input: AttestationHashInput): Hex {
  for (const value of [input.chainId, input.requestId]) {
    if (typeof value !== "bigint" || value <= 0n || value >= (1n << 256n)) throw new Error("Expected a positive uint256 bigint");
  }
  if (typeof input.controller !== "string" || !isAddress(input.controller) || /^0x0{40}$/i.test(input.controller)) throw new Error("Expected a nonzero controller address");
  if (typeof input.requestHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.requestHash) || BigInt(input.requestHash) === 0n) throw new Error("Expected a nonzero bytes32 request hash");
  if (typeof input.approved !== "boolean") throw new Error("Expected a boolean decision");
  for (const value of [input.observedAt, input.validUntil]) {
    if (typeof value !== "bigint" || value < 0n || value >= (1n << 64n)) throw new Error("Expected a uint64 timestamp bigint");
  }
  if (input.validUntil <= input.observedAt || input.validUntil - input.observedAt > 60n) throw new Error("Expected an attestation window of 1–60 seconds");
  return keccak256(encodeAbiParameters(attestationHashParameters, [
    input.chainId, input.controller, input.requestId, input.requestHash, input.approved, input.observedAt, input.validUntil,
  ]));
}
