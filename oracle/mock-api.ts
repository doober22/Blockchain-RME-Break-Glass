import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Address, Hex } from "viem";
import {
  EmergencyContextError,
  MAX_ATTESTATION_AGE_SECONDS,
  hashClinicalEvidence,
  parseEmergencyContext,
  parseNonzeroAddress,
  parseNonzeroBytes32,
  type EmergencyContext,
} from "./emergency-context.ts";

export type EncounterLifecycleStatus = "arrived" | "triaged" | "in-progress" | "finished" | "cancelled";
export type EncounterVisitClass = "EMER" | "AMB" | "IMP";
export type TriageSeverity = "resuscitation" | "emergent" | "urgent" | "non-urgent";
export type PatientResponsiveness = "unresponsive" | "pain" | "voice" | "alert";

/**
 * SATUSEHAT-informed synthetic facility assessment model.
 * Visit class EMER alone does not imply emergency triage or inability to consent.
 */
export interface SyntheticClinicalAssessment {
  encounterId: Hex;
  facilityId: Hex;
  patientWallet: Address;
  clinicianWallet: Address;
  attendingClinicianWallet: Address;
  encounterStatus: EncounterLifecycleStatus;
  visitClass: EncounterVisitClass;
  triageSeverity: TriageSeverity;
  responsiveness: PatientResponsiveness;
  consentCapable: boolean;
  evidence: { salt: Hex; canonicalEvidence: string } | { commitment: Hex };
  /** Clinical observation timestamp in integer Unix seconds; never refreshed by HTTP reads. */
  observedAt: number;
  /** Optional validity window in seconds (1..60, defaults to 60). */
  validitySeconds?: number;
}

const VALID_STATUSES = new Set<EncounterLifecycleStatus>(["arrived", "triaged", "in-progress", "finished", "cancelled"]);
const VALID_CLASSES = new Set<EncounterVisitClass>(["EMER", "AMB", "IMP"]);
const VALID_TRIAGE = new Set<TriageSeverity>(["resuscitation", "emergent", "urgent", "non-urgent"]);
const VALID_RESPONSIVENESS = new Set<PatientResponsiveness>(["unresponsive", "pain", "voice", "alert"]);

/**
 * Derives an EmergencyContext payload from a synthetic clinical assessment.
 * Preserves the original assessment timestamp rather than refreshing it to wall-clock time.
 */
export function deriveEmergencyContext(assessment: SyntheticClinicalAssessment): EmergencyContext {
  if (typeof assessment !== "object" || assessment === null) {
    throw new EmergencyContextError("invalid_schema", "Expected a synthetic clinical assessment object");
  }
  if (!VALID_STATUSES.has(assessment.encounterStatus) || !VALID_CLASSES.has(assessment.visitClass)
      || !VALID_TRIAGE.has(assessment.triageSeverity) || !VALID_RESPONSIVENESS.has(assessment.responsiveness)
      || typeof assessment.consentCapable !== "boolean") {
    throw new EmergencyContextError("invalid_schema", "Invalid synthetic clinical assessment enum or capability flag");
  }
  const clinicianWallet = parseNonzeroAddress(assessment.clinicianWallet, "clinicianWallet");
  const attendingClinicianWallet = parseNonzeroAddress(assessment.attendingClinicianWallet, "attendingClinicianWallet");
  const validitySeconds = assessment.validitySeconds ?? MAX_ATTESTATION_AGE_SECONDS;
  if (!Number.isSafeInteger(validitySeconds) || validitySeconds < 1 || validitySeconds > MAX_ATTESTATION_AGE_SECONDS) {
    throw new EmergencyContextError("invalid_window", "Expected validitySeconds between 1 and 60");
  }
  if (typeof assessment.observedAt !== "number" || !Number.isSafeInteger(assessment.observedAt) || assessment.observedAt < 0) {
    throw new EmergencyContextError("invalid_timestamps", "Expected non-negative integer Unix seconds for observedAt");
  }
  if (typeof assessment.evidence !== "object" || assessment.evidence === null) {
    throw new EmergencyContextError("invalid_schema", "Expected clinical evidence commitment or salt+canonicalEvidence");
  }
  const evidenceCommitment =
    "commitment" in assessment.evidence
      ? parseNonzeroBytes32(assessment.evidence.commitment, "evidence.commitment")
      : hashClinicalEvidence(assessment.evidence.salt, assessment.evidence.canonicalEvidence);

  const encounterActive =
    assessment.encounterStatus === "arrived" ||
    assessment.encounterStatus === "triaged" ||
    assessment.encounterStatus === "in-progress";
  const emergency =
    assessment.visitClass === "EMER" &&
    (assessment.triageSeverity === "resuscitation" || assessment.triageSeverity === "emergent");
  // EMER visit class alone never implies inability to consent if the patient is alert or capable of consenting.
  const patientUnableToConsent = !assessment.consentCapable && assessment.responsiveness !== "alert";
  const clinicianAssigned = attendingClinicianWallet === clinicianWallet;

  return parseEmergencyContext({
    encounterId: assessment.encounterId,
    patientWallet: assessment.patientWallet,
    clinicianWallet,
    facilityId: assessment.facilityId,
    encounterActive,
    emergency,
    patientUnableToConsent,
    clinicianAssigned,
    evidenceCommitment,
    observedAt: assessment.observedAt,
    validUntil: assessment.observedAt + validitySeconds,
  });
}

function isAssessment(entry: EmergencyContext | SyntheticClinicalAssessment): entry is SyntheticClinicalAssessment {
  return "encounterStatus" in entry || "visitClass" in entry;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function sendJson(res: ServerResponse, status: number, body: object, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function verifyBearerAuth(req: IncomingMessage, expectedDigest: Buffer): "ok" | "missing" | "invalid" {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return "missing";
  }
  const candidate = header.slice("Bearer ".length).trim();
  if (candidate.length === 0) {
    return "missing";
  }
  return timingSafeEqual(tokenDigest(candidate), expectedDigest) ? "ok" : "invalid";
}

/**
 * Creates an authenticated synthetic facility API server exposing:
 * GET /api/v1/encounters/{encounterId}/emergency-context
 */
export function createMockFacilityApi(config: {
  facilityId: Hex;
  serviceToken: string;
  encounters?: Iterable<EmergencyContext | SyntheticClinicalAssessment>;
}) {
  const facilityId = parseNonzeroBytes32(config.facilityId, "config.facilityId");
  if (typeof config.serviceToken !== "string" || config.serviceToken.trim().length < 16) {
    throw new Error("Mock facility API requires a serviceToken of at least 16 characters");
  }
  const expectedDigest = tokenDigest(config.serviceToken.trim());
  const store = new Map<Hex, EmergencyContext>();

  function upsert(entry: EmergencyContext | SyntheticClinicalAssessment): EmergencyContext {
    const context = isAssessment(entry) ? deriveEmergencyContext(entry) : parseEmergencyContext(entry);
    if (context.facilityId !== facilityId) {
      throw new EmergencyContextError("facility_mismatch", "Encounter facilityId does not match this facility server");
    }
    store.set(context.encounterId, Object.freeze({ ...context }));
    return context;
  }

  function remove(encounterId: Hex): boolean {
    return store.delete(parseNonzeroBytes32(encounterId, "encounterId"));
  }

  function get(encounterId: Hex): EmergencyContext | undefined {
    const record = store.get(parseNonzeroBytes32(encounterId, "encounterId"));
    return record ? { ...record } : undefined;
  }

  if (config.encounters) {
    for (const entry of config.encounters) {
      upsert(entry);
    }
  }

  const routePattern = /^\/api\/v1\/encounters\/([^/]+)\/emergency-context$/;

  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (req, res) => {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.search.length > 0) {
        return sendJson(res, 400, { error: "unexpected_query_parameters" });
      }
      const match = routePattern.exec(url.pathname);
      if (!match) {
        return sendJson(res, 404, { error: "not_found" });
      }
      const auth = verifyBearerAuth(req, expectedDigest);
      if (auth === "missing") {
        return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      }
      if (auth === "invalid") {
        return sendJson(res, 403, { error: "forbidden" });
      }

      let encounterId: Hex;
      try {
        encounterId = parseNonzeroBytes32(decodeURIComponent(match[1]), "encounterId");
      } catch {
        return sendJson(res, 400, { error: "invalid_encounter_id" });
      }

      const context = store.get(encounterId);
      if (!context) {
        return sendJson(res, 404, { error: "encounter_not_found" });
      }
      return sendJson(res, 200, context);
    },
  );

  return { server, facilityId, upsert, remove, get };
}

/**
 * Queries a trusted facility emergency-context endpoint with server-to-server bearer authentication,
 * a 3-second default timeout, and runtime schema and path/facility binding checks.
 */
export async function fetchEmergencyContext(config: {
  baseUrl: string;
  encounterId: Hex;
  serviceToken: string;
  expectedFacilityId?: Hex;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<EmergencyContext> {
  const encounterId = parseNonzeroBytes32(config.encounterId, "encounterId");
  const expectedFacilityId =
    config.expectedFacilityId !== undefined
      ? parseNonzeroBytes32(config.expectedFacilityId, "expectedFacilityId")
      : undefined;
  if (typeof config.serviceToken !== "string" || config.serviceToken.trim().length === 0) {
    throw new EmergencyContextError("api_unauthorized", "Missing facility API service token");
  }
  const timeoutMs = config.timeoutMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Expected timeoutMs between 1 and 30000");
  }
  let endpoint: URL;
  try {
    const parsedBase = new URL(config.baseUrl);
    if (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    endpoint = new URL(`/api/v1/encounters/${encounterId}/emergency-context`, parsedBase.origin);
  } catch {
    throw new EmergencyContextError("api_unreachable", "Invalid facility API base URL");
  }

  const fetchFn = config.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.serviceToken.trim()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new EmergencyContextError("api_unreachable", "Facility emergency-context request failed or timed out");
  }

  if (response.status === 401 || response.status === 403) {
    throw new EmergencyContextError("api_unauthorized", `Facility API rejected authentication (${response.status})`);
  }
  if (response.status === 404) {
    throw new EmergencyContextError("encounter_not_found", "Encounter not found at facility API");
  }
  if (response.status !== 200) {
    throw new EmergencyContextError("api_http_error", `Facility API returned HTTP ${response.status}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new EmergencyContextError("invalid_json", "Facility API did not return valid JSON");
  }

  const context = parseEmergencyContext(raw);
  if (context.encounterId !== encounterId) {
    throw new EmergencyContextError("encounter_mismatch", "Response encounterId does not match requested path");
  }
  if (expectedFacilityId && context.facilityId !== expectedFacilityId) {
    throw new EmergencyContextError("facility_mismatch", "Response facilityId does not match trusted facility configuration");
  }
  return context;
}
