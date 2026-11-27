import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { toHex, type Address, type Hex } from "viem";
import { hashEmergencyAttestation } from "../smart-contract/integration/attestation-hash.ts";
import { hashEmergencyRequest } from "../smart-contract/integration/request-hash.ts";
import {
  EmergencyContextError,
  evaluateEmergencyContext,
  hashClinicalEvidence,
  parseEmergencyContext,
  type EmergencyContext,
  type EmergencyEvaluationReason,
  type OnChainEmergencyRequest,
} from "./emergency-context.ts";
import {
  createMockFacilityApi,
  deriveEmergencyContext,
  fetchEmergencyContext,
  type SyntheticClinicalAssessment,
} from "./mock-api.ts";

const bytes32 = (value: number): Hex => toHex(value, { size: 32 });
const chainId = 1337n;
const controller: Address = "0x1111111111111111111111111111111111111111";
const patientWallet: Address = "0x2222222222222222222222222222222222222222";
const clinicianWallet: Address = "0x3333333333333333333333333333333333333333";
const otherClinicianWallet: Address = "0x7777777777777777777777777777777777777777";
const facilityA: Hex = `0x${"44".repeat(32)}`;
const facilityB: Hex = `0x${"88".repeat(32)}`;
const encounterId: Hex = `0x${"55".repeat(32)}`;
const evidenceSalt: Hex = `0x${"aa".repeat(32)}`;
const canonicalEvidence = "IGD-TRIAGE:ESI-1;GCS:6;UNRESPONSIVE;SPO2:82";
const evidenceCommitment = hashClinicalEvidence(evidenceSalt, canonicalEvidence);

const baseAssessment: SyntheticClinicalAssessment = {
  encounterId,
  facilityId: facilityA,
  patientWallet,
  clinicianWallet,
  attendingClinicianWallet: clinicianWallet,
  encounterStatus: "in-progress",
  visitClass: "EMER",
  triageSeverity: "emergent",
  responsiveness: "unresponsive",
  consentCapable: false,
  evidence: { salt: evidenceSalt, canonicalEvidence },
  observedAt: 1_000,
  validitySeconds: 60,
};

function makePendingRequest(overrides: Partial<OnChainEmergencyRequest> = {}): OnChainEmergencyRequest {
  const base = {
    exists: true,
    requestId: 1n,
    patient: patientWallet,
    clinician: clinicianWallet,
    requesterFacilityId: facilityA,
    encounterId,
    recordIds: [bytes32(10), bytes32(11)],
    reasonCode: 7,
    evidenceCommitment,
    requestedDuration: 900n,
    decisionDeadline: 1_120n,
    status: 0,
  };
  const merged = { ...base, ...overrides };
  const requestHash =
    overrides.requestHash ??
    hashEmergencyRequest({
      chainId,
      controller,
      requestId: merged.requestId,
      patient: merged.patient,
      clinician: merged.clinician,
      requesterFacilityId: merged.requesterFacilityId,
      encounterId: merged.encounterId,
      recordIds: merged.recordIds,
      reasonCode: merged.reasonCode,
      evidenceCommitment: merged.evidenceCommitment,
      requestedDuration: merged.requestedDuration,
      decisionDeadline: merged.decisionDeadline,
    });
  return { ...merged, requestHash };
}

test("clinical evidence commitment binds salt and canonical evidence deterministically", () => {
  const same = hashClinicalEvidence(evidenceSalt, canonicalEvidence);
  assert.equal(same, evidenceCommitment);
  assert.notEqual(hashClinicalEvidence(bytes32(9), canonicalEvidence), evidenceCommitment);
  assert.notEqual(hashClinicalEvidence(evidenceSalt, `${canonicalEvidence};MODIFIED`), evidenceCommitment);
  assert.throws(() => hashClinicalEvidence(bytes32(0), canonicalEvidence), { name: "EmergencyContextError" });
  assert.throws(() => hashClinicalEvidence(evidenceSalt, "   "), { name: "EmergencyContextError" });
});

test("SATUSEHAT-informed derivation requires triage emergency, inability to consent, active encounter, and assigned clinician", () => {
  const derived = deriveEmergencyContext(baseAssessment);
  assert.equal(derived.encounterActive, true);
  assert.equal(derived.emergency, true);
  assert.equal(derived.patientUnableToConsent, true);
  assert.equal(derived.clinicianAssigned, true);
  assert.equal(derived.evidenceCommitment, evidenceCommitment);
  assert.equal(derived.observedAt, 1_000);
  assert.equal(derived.validUntil, 1_060);

  // EMER visit class alone does not make an alert or consent-capable patient unable to consent.
  const alertEmer = deriveEmergencyContext({ ...baseAssessment, responsiveness: "alert", consentCapable: false });
  assert.equal(alertEmer.emergency, true);
  assert.equal(alertEmer.patientUnableToConsent, false);

  const capableEmer = deriveEmergencyContext({ ...baseAssessment, responsiveness: "pain", consentCapable: true });
  assert.equal(capableEmer.patientUnableToConsent, false);

  const nonUrgentEmer = deriveEmergencyContext({ ...baseAssessment, triageSeverity: "non-urgent" });
  assert.equal(nonUrgentEmer.emergency, false);

  const ambulatory = deriveEmergencyContext({ ...baseAssessment, visitClass: "AMB" });
  assert.equal(ambulatory.emergency, false);

  const finished = deriveEmergencyContext({ ...baseAssessment, encounterStatus: "finished" });
  assert.equal(finished.encounterActive, false);

  const unassigned = deriveEmergencyContext({ ...baseAssessment, attendingClinicianWallet: otherClinicianWallet });
  assert.equal(unassigned.clinicianAssigned, false);
});

test("runtime schema validator enforces nonzero bytes32, distinct addresses, booleans, and 1–60s validity windows", () => {
  const valid = deriveEmergencyContext(baseAssessment);
  assert.deepEqual(parseEmergencyContext({ ...valid, observedAt: 1_000, validUntil: 1_001 }), {
    ...valid,
    observedAt: 1_000,
    validUntil: 1_001,
  });

  const invalidPayloads: unknown[] = [
    null,
    [],
    "not-an-object",
    { ...valid, encounterId: bytes32(0) },
    { ...valid, facilityId: "0x1234" },
    { ...valid, evidenceCommitment: bytes32(0) },
    { ...valid, patientWallet: "0x0000000000000000000000000000000000000000" },
    { ...valid, clinicianWallet: "0x1234" },
    { ...valid, clinicianWallet: valid.patientWallet },
    { ...valid, encounterActive: "true" },
    { ...valid, emergency: 1 },
    { ...valid, patientUnableToConsent: null },
    { ...valid, clinicianAssigned: undefined },
    { ...valid, observedAt: -1, validUntil: 10 },
    { ...valid, observedAt: 1000.5, validUntil: 1030 },
    { ...valid, observedAt: 1_000, validUntil: 1_000 },
    { ...valid, observedAt: 1_000, validUntil: 999 },
    { ...valid, observedAt: 1_000, validUntil: 1_061 },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(() => parseEmergencyContext(payload), (error: unknown) => error instanceof EmergencyContextError);
  }
});

test("evaluator approves valid emergency context, rejects valid negative clinical facts, and fails closed on mismatch or staleness", () => {
  const request = makePendingRequest();
  const context = deriveEmergencyContext(baseAssessment);

  // Positive resolution at observedAt (1000) and at maximum usable age (1059, 1 second before validUntil).
  for (const now of [1_000n, 1_059n]) {
    const decision = evaluateEmergencyContext({ chainId, controller, request, context, now });
    assert.equal(decision.action, "resolve");
    if (decision.action !== "resolve") assert.fail("Expected resolve decision");
    assert.equal(decision.approved, true);
    assert.equal(decision.requestId, 1n);
    assert.equal(decision.requestHash, request.requestHash);
    assert.equal(decision.observedAt, 1_000n);
    assert.equal(decision.validUntil, 1_060n);
    assert.equal(
      decision.attestationHash,
      hashEmergencyAttestation({
        chainId,
        controller,
        requestId: 1n,
        requestHash: request.requestHash,
        approved: true,
        observedAt: 1_000n,
        validUntil: 1_060n,
      }),
    );
  }

  // Valid negative clinical facts produce REJECT (approved: false), not approval or silent pass.
  const negativeContexts: EmergencyContext[] = [
    deriveEmergencyContext({ ...baseAssessment, encounterStatus: "finished" }),
    deriveEmergencyContext({ ...baseAssessment, triageSeverity: "urgent" }),
    deriveEmergencyContext({ ...baseAssessment, responsiveness: "alert" }),
    deriveEmergencyContext({ ...baseAssessment, consentCapable: true }),
    deriveEmergencyContext({ ...baseAssessment, attendingClinicianWallet: otherClinicianWallet }),
  ];
  for (const negContext of negativeContexts) {
    const decision = evaluateEmergencyContext({ chainId, controller, request, context: negContext, now: 1_010n });
    assert.equal(decision.action, "resolve");
    if (decision.action !== "resolve") assert.fail("Expected resolve decision");
    assert.equal(decision.approved, false);
    assert.equal(
      decision.attestationHash,
      hashEmergencyAttestation({
        chainId,
        controller,
        requestId: 1n,
        requestHash: request.requestHash,
        approved: false,
        observedAt: 1_000n,
        validUntil: 1_060n,
      }),
    );
  }

  // Technical, binding, deadline, status, or freshness violations must abstain (fail-closed).
  const abstainCases: Array<{
    request?: OnChainEmergencyRequest;
    context?: unknown;
    now?: bigint;
    reason: EmergencyEvaluationReason;
  }> = [
    { request: { ...request, status: 2 }, reason: "request_not_pending" },
    { request: { ...request, exists: false }, reason: "request_not_pending" },
    { now: 1_120n, reason: "request_deadline_passed" },
    { request: { ...request, requestHash: bytes32(99) }, reason: "request_hash_mismatch" },
    { request: { ...request, recordIds: [] }, reason: "invalid_request_binding" },
    { context: { ...context, encounterId: bytes32(77) }, reason: "encounter_mismatch" },
    { context: { ...context, facilityId: facilityB }, reason: "facility_mismatch" },
    { context: { ...context, patientWallet: otherClinicianWallet }, reason: "patient_mismatch" },
    { context: { ...context, clinicianWallet: otherClinicianWallet }, reason: "clinician_mismatch" },
    { context: { ...context, evidenceCommitment: bytes32(88) }, reason: "evidence_mismatch" },
    { now: 999n, reason: "future_observation" },
    { now: 1_060n, reason: "expired_observation" },
    {
      context: { ...context, observedAt: 1_000, validUntil: 1_061 },
      now: 1_030n,
      reason: "invalid_window",
    },
  ];

  for (const testCase of abstainCases) {
    const result = evaluateEmergencyContext({
      chainId,
      controller,
      request: testCase.request ?? request,
      context: testCase.context ?? context,
      now: testCase.now ?? 1_010n,
    });
    assert.deepEqual(result, { action: "abstain", reason: testCase.reason });
  }
});

test("mock facility API enforces bearer authentication, facility isolation, immutable observedAt, and client timeout/validation", async (t) => {
  const serviceToken = "facility-a-secret-service-token-001";
  const api = createMockFacilityApi({
    facilityId: facilityA,
    serviceToken,
    encounters: [baseAssessment],
  });
  api.server.listen(0, "127.0.0.1");
  await once(api.server, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => api.server.close((err) => (err ? reject(err) : resolve()))));

  const address = api.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const path = `/api/v1/encounters/${encounterId}/emergency-context`;

  // Rejects cross-facility encounter registration on facility A's server.
  assert.throws(
    () => api.upsert({ ...baseAssessment, facilityId: facilityB }),
    (err: unknown) => err instanceof EmergencyContextError && err.code === "facility_mismatch",
  );

  // Missing bearer token -> 401
  const noAuth = await fetch(`${baseUrl}${path}`);
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get("www-authenticate"), "Bearer");

  // Wrong bearer token -> 403
  const badAuth = await fetch(`${baseUrl}${path}`, { headers: { Authorization: "Bearer wrong-service-token-value" } });
  assert.equal(badAuth.status, 403);
  await assert.rejects(
    () => fetchEmergencyContext({ baseUrl, encounterId, serviceToken: "wrong-service-token-value" }),
    (err: unknown) => err instanceof EmergencyContextError && err.code === "api_unauthorized",
  );

  // Non-GET -> 405
  const postRes = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(postRes.status, 405);

  // Malformed encounter ID in path -> 400
  const invalidIdRes = await fetch(`${baseUrl}/api/v1/encounters/not-a-bytes32/emergency-context`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(invalidIdRes.status, 400);

  // Unknown encounter -> 404
  await assert.rejects(
    () => fetchEmergencyContext({ baseUrl, encounterId: bytes32(404), serviceToken }),
    (err: unknown) => err instanceof EmergencyContextError && err.code === "encounter_not_found",
  );

  // Valid fetch returns exact context and does not refresh observedAt across repeated fetches.
  const firstFetch = await fetchEmergencyContext({
    baseUrl,
    encounterId,
    serviceToken,
    expectedFacilityId: facilityA,
  });
  const secondFetch = await fetchEmergencyContext({
    baseUrl,
    encounterId,
    serviceToken,
    expectedFacilityId: facilityA,
  });
  assert.deepEqual(firstFetch, secondFetch);
  assert.equal(firstFetch.observedAt, 1_000);
  assert.equal(firstFetch.validUntil, 1_060);

  // Expected facility mismatch fails closed in client helper.
  await assert.rejects(
    () => fetchEmergencyContext({ baseUrl, encounterId, serviceToken, expectedFacilityId: facilityB }),
    (err: unknown) => err instanceof EmergencyContextError && err.code === "facility_mismatch",
  );

  // When chain time advances past validUntil without a new clinical assessment, re-fetching still fails closed.
  const staleEval = evaluateEmergencyContext({
    chainId,
    controller,
    request: makePendingRequest(),
    context: secondFetch,
    now: 1_060n,
  });
  assert.deepEqual(staleEval, { action: "abstain", reason: "expired_observation" });

  // Timeout and malformed JSON fail closed in fetchEmergencyContext.
  const slowServer = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 250);
  });
  slowServer.listen(0, "127.0.0.1");
  await once(slowServer, "listening");
  t.after(async () => new Promise<void>((resolve, reject) => slowServer.close((err) => (err ? reject(err) : resolve()))));
  const slowAddr = slowServer.address();
  assert.ok(slowAddr && typeof slowAddr !== "string");
  await assert.rejects(
    () =>
      fetchEmergencyContext({
        baseUrl: `http://127.0.0.1:${slowAddr.port}`,
        encounterId,
        serviceToken,
        timeoutMs: 40,
      }),
    (err: unknown) => err instanceof EmergencyContextError && err.code === "api_unreachable",
  );
});
