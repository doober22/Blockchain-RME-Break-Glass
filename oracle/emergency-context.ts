import { encodeAbiParameters, getAddress, isAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { hashEmergencyAttestation } from "../smart-contract/integration/attestation-hash.ts";
import { hashEmergencyRequest } from "../smart-contract/integration/request-hash.ts";

/** Proposed synthetic project API response, NOT a SATUSEHAT API or validator. */
export interface EmergencyContext {
  /** Random synthetic bytes32 encoded as 0x-prefixed hex. */
  encounterId: `0x${string}`;
  patientWallet: `0x${string}`;
  clinicianWallet: `0x${string}`;
  facilityId: `0x${string}`;
  encounterActive: boolean;
  emergency: boolean;
  patientUnableToConsent: boolean;
  clinicianAssigned: boolean;
  evidenceCommitment: `0x${string}`;
  /** Integer Unix seconds, not milliseconds. Validate at runtime. */
  observedAt: number;
  /** Integer Unix seconds; expiry must be checked against chain time too. */
  validUntil: number;
}

export const MAX_ATTESTATION_AGE_SECONDS = 60;
const MAX_UINT64 = (1n << 64n) - 1n;
const evidenceParameters = parseAbiParameters("bytes32 salt, string canonicalEvidence");

export type EmergencyEvaluationReason =
  | "invalid_schema"
  | "invalid_identifier"
  | "invalid_address"
  | "invalid_boolean"
  | "invalid_timestamps"
  | "invalid_window"
  | "invalid_reference_time"
  | "request_not_pending"
  | "request_deadline_passed"
  | "invalid_request_binding"
  | "request_hash_mismatch"
  | "encounter_mismatch"
  | "facility_mismatch"
  | "patient_mismatch"
  | "clinician_mismatch"
  | "evidence_mismatch"
  | "future_observation"
  | "expired_observation"
  | "stale_observation"
  | "api_unauthorized"
  | "encounter_not_found"
  | "api_http_error"
  | "api_unreachable"
  | "invalid_json";

export class EmergencyContextError extends Error {
  readonly code: EmergencyEvaluationReason;
  constructor(code: EmergencyEvaluationReason, message: string = code) {
    super(message);
    this.name = "EmergencyContextError";
    this.code = code;
  }
}

export interface OnChainEmergencyRequest {
  exists?: boolean;
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
  requestHash: Hex;
  status: number;
}

export type EmergencyEvaluationResult =
  | {
      action: "resolve";
      approved: boolean;
      requestId: bigint;
      requestHash: Hex;
      observedAt: bigint;
      validUntil: bigint;
      attestationHash: Hex;
      context: EmergencyContext;
    }
  | {
      action: "abstain";
      reason: EmergencyEvaluationReason;
    };

export function parseNonzeroBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) {
    throw new EmergencyContextError("invalid_identifier", `Expected a nonzero bytes32 for ${field}`);
  }
  return value.toLowerCase() as Hex;
}

export function parseNonzeroAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new EmergencyContextError("invalid_address", `Expected a nonzero EVM address for ${field}`);
  }
  const lower = value.toLowerCase();
  if (!isAddress(lower)) {
    throw new EmergencyContextError("invalid_address", `Invalid EVM address for ${field}`);
  }
  return getAddress(lower);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new EmergencyContextError("invalid_boolean", `Expected a boolean for ${field}`);
  }
  return value;
}

function parseUnixSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_UINT64) {
    throw new EmergencyContextError("invalid_timestamps", `Expected an integer Unix-second timestamp for ${field}`);
  }
  return value;
}

/**
 * Computes keccak256(abi.encode(salt, canonicalEvidence)) so clinical evidence
 * and random salt remain off-chain while the commitment is bound on-chain.
 */
export function hashClinicalEvidence(salt: Hex, canonicalEvidence: string): Hex {
  const validSalt = parseNonzeroBytes32(salt, "salt");
  if (typeof canonicalEvidence !== "string" || canonicalEvidence.trim().length === 0) {
    throw new EmergencyContextError("invalid_schema", "Expected non-empty canonical clinical evidence");
  }
  return keccak256(encodeAbiParameters(evidenceParameters, [validSalt, canonicalEvidence]));
}

/** Validates an untrusted JSON payload against the project emergency-context contract. */
export function parseEmergencyContext(value: unknown): EmergencyContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EmergencyContextError("invalid_schema", "Expected an emergency-context JSON object");
  }
  const record = value as Record<string, unknown>;
  const encounterId = parseNonzeroBytes32(record.encounterId, "encounterId");
  const patientWallet = parseNonzeroAddress(record.patientWallet, "patientWallet");
  const clinicianWallet = parseNonzeroAddress(record.clinicianWallet, "clinicianWallet");
  if (patientWallet === clinicianWallet) {
    throw new EmergencyContextError("invalid_address", "Patient and clinician wallets must be distinct");
  }
  const facilityId = parseNonzeroBytes32(record.facilityId, "facilityId");
  const encounterActive = parseBoolean(record.encounterActive, "encounterActive");
  const emergency = parseBoolean(record.emergency, "emergency");
  const patientUnableToConsent = parseBoolean(record.patientUnableToConsent, "patientUnableToConsent");
  const clinicianAssigned = parseBoolean(record.clinicianAssigned, "clinicianAssigned");
  const evidenceCommitment = parseNonzeroBytes32(record.evidenceCommitment, "evidenceCommitment");
  const observedAt = parseUnixSeconds(record.observedAt, "observedAt");
  const validUntil = parseUnixSeconds(record.validUntil, "validUntil");
  if (validUntil <= observedAt || validUntil - observedAt > MAX_ATTESTATION_AGE_SECONDS) {
    throw new EmergencyContextError("invalid_window", "Expected an observation validity window of 1–60 seconds");
  }
  return {
    encounterId,
    patientWallet,
    clinicianWallet,
    facilityId,
    encounterActive,
    emergency,
    patientUnableToConsent,
    clinicianAssigned,
    evidenceCommitment,
    observedAt,
    validUntil,
  };
}

/**
 * Evaluates a facility API response against an on-chain pending request and current chain time.
 * Technical/schema/binding/freshness failures abstain (fail-closed); valid clinical facts resolve true or false.
 */
export function evaluateEmergencyContext(input: {
  chainId: bigint;
  controller: Address;
  request: OnChainEmergencyRequest;
  context: unknown;
  now: bigint;
}): EmergencyEvaluationResult {
  if (typeof input.now !== "bigint" || input.now < 0n || input.now > MAX_UINT64) {
    return { action: "abstain", reason: "invalid_reference_time" };
  }
  const { request } = input;
  if (request.exists === false || request.status !== 0) {
    return { action: "abstain", reason: "request_not_pending" };
  }
  if (input.now >= request.decisionDeadline) {
    return { action: "abstain", reason: "request_deadline_passed" };
  }

  let expectedRequestHash: Hex;
  let patient: Address;
  let clinician: Address;
  let requesterFacilityId: Hex;
  let encounterId: Hex;
  let evidenceCommitment: Hex;
  try {
    patient = parseNonzeroAddress(request.patient, "request.patient");
    clinician = parseNonzeroAddress(request.clinician, "request.clinician");
    requesterFacilityId = parseNonzeroBytes32(request.requesterFacilityId, "request.requesterFacilityId");
    encounterId = parseNonzeroBytes32(request.encounterId, "request.encounterId");
    evidenceCommitment = parseNonzeroBytes32(request.evidenceCommitment, "request.evidenceCommitment");
    expectedRequestHash = hashEmergencyRequest({
      chainId: input.chainId,
      controller: input.controller,
      requestId: request.requestId,
      patient,
      clinician,
      requesterFacilityId,
      encounterId,
      recordIds: request.recordIds,
      reasonCode: request.reasonCode,
      evidenceCommitment,
      requestedDuration: request.requestedDuration,
      decisionDeadline: request.decisionDeadline,
    });
  } catch {
    return { action: "abstain", reason: "invalid_request_binding" };
  }

  if ( typeof request.requestHash !== "string" || expectedRequestHash.toLowerCase() !== request.requestHash.toLowerCase()) {
    return { action: "abstain", reason: "request_hash_mismatch" };
  }

  let parsed: EmergencyContext;
  try {
    parsed = parseEmergencyContext(input.context);
  } catch (error) {
    if (error instanceof EmergencyContextError) {
      return { action: "abstain", reason: error.code };
    }
    return { action: "abstain", reason: "invalid_schema" };
  }

  if (parsed.encounterId !== encounterId) {
    return { action: "abstain", reason: "encounter_mismatch" };
  }
  if (parsed.facilityId !== requesterFacilityId) {
    return { action: "abstain", reason: "facility_mismatch" };
  }
  if (parsed.patientWallet !== patient) {
    return { action: "abstain", reason: "patient_mismatch" };
  }
  if (parsed.clinicianWallet !== clinician) {
    return { action: "abstain", reason: "clinician_mismatch" };
  }
  if (parsed.evidenceCommitment !== evidenceCommitment) {
    return { action: "abstain", reason: "evidence_mismatch" };
  }

  const observedAt = BigInt(parsed.observedAt);
  const validUntil = BigInt(parsed.validUntil);
  if (observedAt > input.now) {
    return { action: "abstain", reason: "future_observation" };
  }
  if (input.now >= validUntil) {
    return { action: "abstain", reason: "expired_observation" };
  }
  if (input.now - observedAt > BigInt(MAX_ATTESTATION_AGE_SECONDS)) {
    return { action: "abstain", reason: "stale_observation" };
  }

  const approved =
    parsed.encounterActive &&
    parsed.emergency &&
    parsed.patientUnableToConsent &&
    parsed.clinicianAssigned;

  let attestationHash: Hex;
  try {
    attestationHash = hashEmergencyAttestation({
      chainId: input.chainId,
      controller: input.controller,
      requestId: request.requestId,
      requestHash: expectedRequestHash,
      approved,
      observedAt,
      validUntil,
    });
  } catch {
    return { action: "abstain", reason: "invalid_window" };
  }

  return {
    action: "resolve",
    approved,
    requestId: request.requestId,
    requestHash: expectedRequestHash,
    observedAt,
    validUntil,
    attestationHash,
    context: parsed,
  };
}
