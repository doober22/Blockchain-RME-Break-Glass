import { encodeAbiParameters, isAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

/** Exact encoding of Solidity abi.encode(EmergencyRequestBinding), a single dynamic tuple. */
export const requestHashParameters = parseAbiParameters(
  "(uint256 chainId, address controller, uint256 requestId, address patient, address clinician, bytes32 requesterFacilityId, bytes32 encounterId, bytes32[] recordIds, uint16 reasonCode, bytes32 evidenceCommitment, uint64 requestedDuration, uint64 decisionDeadline)",
);

export interface RequestHashInput {
  chainId: bigint;
  controller: Address;
  requestId: bigint;
  patient: Address;
  clinician: Address;
  requesterFacilityId: Hex;
  encounterId: Hex;
  recordIds: readonly Hex[];
  reasonCode: number;
  evidenceCommitment: Hex;
  requestedDuration: bigint;
  decisionDeadline: bigint;
}

function positiveUint(value: bigint, bits: number, name: string): void {
  if (typeof value !== "bigint" || value <= 0n || value >= 1n << BigInt(bits)) {
    throw new Error(`Invalid ${name}: expected a positive uint${bits} bigint`);
  }
}

function nonzeroBytes32(value: Hex): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) {
    throw new Error("Expected a nonzero bytes32");
  }
}

/** Side-effect-free helper: does not sort, mutate input, read environment, or load signers. */
export function hashEmergencyRequest(input: RequestHashInput): Hex {
  positiveUint(input.chainId, 256, "chainId");
  positiveUint(input.requestId, 256, "requestId");
  positiveUint(input.requestedDuration, 64, "requestedDuration");
  positiveUint(input.decisionDeadline, 64, "decisionDeadline");
  if (input.requestedDuration > 900n) throw new Error("Emergency duration exceeds 900 seconds");
  for (const address of [input.controller, input.patient, input.clinician]) {
    if (typeof address !== "string" || !isAddress(address) || /^0x0{40}$/i.test(address)) throw new Error("Expected a nonzero EVM address");
  }
  for (const value of [input.requesterFacilityId, input.encounterId, input.evidenceCommitment]) nonzeroBytes32(value);
  if (!Number.isInteger(input.reasonCode) || input.reasonCode <= 0 || input.reasonCode > 65_535) throw new Error("Expected a nonzero uint16 reasonCode");
  if (!Array.isArray(input.recordIds) || input.recordIds.length < 1 || input.recordIds.length > 20) throw new Error("Expected 1–20 record IDs");
  let previous = 0n;
  for (const recordId of input.recordIds) {
    nonzeroBytes32(recordId);
    const current = BigInt(recordId);
    if (current <= previous) throw new Error("Record IDs must be strictly increasing");
    previous = current;
  }
  return keccak256(encodeAbiParameters(requestHashParameters, [{ ...input, recordIds: [...input.recordIds] }]));
}
