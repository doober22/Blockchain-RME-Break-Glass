# Smart contracts

Solidity contracts, ABI exports, tests, and deployment tooling for the RME private chain.

`ParticipantRegistry` manages who participates in the system and whether their credentials are valid. `MedicalAccessController` implements record lifecycle, normal consent/revocation, bounded emergency requests and oracle resolution, plus recorded normal/emergency read authorization. Emergency closure, review, and overdue queries remain reverting stubs. The deployment tooling connects both contracts and exports their public interfaces for application services.

## Toolchain

Node.js 24 LTS, Hardhat 3.21.1, Solidity 0.8.28, OpenZeppelin Contracts 5.6.1, TypeScript 5.9.3, and viem 2.57.16. Dependencies are pinned in `smart-contract/package.json` and its lockfile. Solidity uses the `paris` EVM target with optimizer enabled for 200 runs.

## ParticipantRegistry

Stores facilities, participant credentials, and application roles through OpenZeppelin `AccessControl`.

A facility has an ID and active status. A participant is identified by a wallet address and has an active status, facility affiliation, and credential expiry. Roles are stored separately, allowing a wallet to hold compatible application roles while sharing one credential record. The registry stores these identifiers and credentials rather than names, NIK, or clinical data.

| Methods | Behavior |
| --- | --- |
| `constructor(initialAdmin)` | Assigns the initial admin; rejects a zero address. |
| `registerFacility()`, `setFacilityActive()` | Create an active facility with a unique nonzero ID, or change an existing facility's status. Admin only. |
| `registerParticipant()`, `updateParticipant()` | Register a wallet with an application role, or update its affiliation, expiry, and active status. Registration requires a unique nonzero wallet and future expiry. Admin only. |
| `grantRole()`, `revokeRole()` | Assign or remove roles through authorized role admins. Application grants require registered, active, unexpired credentials and compatible roles. |
| `renounceRole()` | Lets an account remove its own role. |
| `isEligible()` | Checks role membership, active credentials, expiry, and required facility status. |
| `getParticipant()`, `getFacility()` | Return metadata with an `exists` flag. |
| `hasRole()`, `getRoleAdmin()`, `supportsInterface()` | OpenZeppelin membership, administration, and interface queries. |

- Patient and auditor roles may have no facility affiliation. Clinician, oracle, and gateway roles require an active facility.
- Nonzero affiliations must reference a registered facility. Registration, role grants, and activation require active affiliation.
- Eligibility expires at `block.timestamp >= validUntil`. Facility deactivation blocks affiliated operational roles.
- Clinician wallets cannot hold oracle or gateway roles. Credentials and affiliation are shared across an account's application roles.
- Admin assignment is separate from participant registration. Admin status alone grants no medical access.
- Credential changes and role revocation preserve participant identity and event history. `hasRole()` checks membership only; use `isEligible()` for current credentials.

For example, a doctor may retain `CLINICIAN_ROLE` after their credentials expire, but `isEligible()` returns false from the expiry timestamp onward. Disabling the doctor's facility has the same effect on eligibility. Renewing credentials or reactivating the facility restores eligibility when all other checks pass. Account deactivation and role revocation remain available even after expiry.

Role validation also applies to inherited `grantRole()` calls, so they cannot bypass participant registration or assign oracle/gateway roles to a clinician wallet. Registration and status changes emit registry events; role changes emit OpenZeppelin's `RoleGranted` and `RoleRevoked` events.

## MedicalAccessController

Holds an immutable registry reference, record/consent/request/review structs, request-record membership, counters, replay-tracking fields, and event declarations.

Records describe ownership, issuing facility, ciphertext hash, category, and active status. Consent links a patient, clinician, record, and expiry. Emergency requests group the selected records, encounter reference, evidence commitment, timestamps, and decision status. Reviews hold an auditor's verdict and report commitment. These structures contain metadata; medical-record contents, evidence, and encryption keys stay off-chain.

| Methods | Behavior |
| --- | --- |
| `constructor(registry)` | Stores a nonzero registry address with deployed code. |
| `registry()` and constant getters | Return configuration. |
| `getRecord()`, `getConsent()`, `getRequest()`, `getReview()` | Return metadata with an `exists` flag. |
| `registerRecord()` | Eligible gateway registers a unique nonzero record ID and ciphertext hash for an eligible patient. Issuing facility comes from the gateway's current registry affiliation. Stores category and emits `RecordRegistered`. |
| `deactivateRecord()` | Eligible gateway of the issuing facility deactivates an existing active record and emits `RecordDeactivated`. Preserves all metadata; repeated deactivation is rejected. |
| `grantConsent()` | Eligible patient owning the active record grants an eligible clinician read consent until a future expiry. Requires active issuing facility; creates a new monotonic ID and emits `ConsentGranted`. |
| `revokeConsent()` | Original patient irreversibly revokes an existing consent and emits `ConsentRevoked`. No current eligibility is required to remove access; repeated revocation is rejected. |
| `canRead()` | Public view of current normal/emergency read policy; false for unknown grants/records, wrong scope/identity/mode, pending/rejected emergency requests, revocation, expiry, inactive credentials/facilities, or changed emergency-requesting affiliation. |
| `authorizeAccess()` | Eligible issuing-facility gateway applies the same current policy, consumes a globally unique nonzero access ID, and emits `AccessAuthorized`. Rejected attempts revert without consuming the ID. |
| `requestEmergency()` | Eligible clinician creates a pending request for an eligible patient's 1–20 sorted unique active records, binding the encounter, reason, evidence commitment, duration, and 120-second deadline. |
| `getRequestRecords()` | Returns the stored bounded scope; unknown request IDs revert with `RequestNotFound`. |
| `getEffectiveStatus()` | Returns the effective status of an existing request, computing expiry at the pending deadline or active expiry. Unknown IDs revert. Rejection is terminal; closure remains unimplemented. |
| `resolveEmergency()` | Eligible requesting-facility oracle decides a pending request before its deadline with matching hash and fresh bounded timestamps. Rechecks all approval prerequisites, stores a domain-bound attestation hash, and emits `EmergencyResolved`. |
| `closeEmergency()`, `submitReview()`, `isReviewOverdue()` | Stubs; all revert with `NotImplemented()`. |

The metadata getters return `exists=false` for unknown IDs. Callers must inspect that flag rather than treating default field values as a valid entry. The constructor checks that the registry address contains code; the deployment workflow additionally verifies the expected registry bytecode and controller reference.

Record IDs cannot be reused, including after deactivation or by a different facility. Patient, issuing facility, ciphertext hash, and category cannot be changed. Corrections require a new ID. Any eligible gateway of the issuing facility may deactivate a record; authority belongs to the facility rather than only the original registering wallet. Moving a gateway to another facility does not transfer the record's issuing facility.

Registration explicitly requires current patient eligibility, including credential expiry and active status, in addition to the design's registered-patient requirement. Deactivation does not require patient eligibility, so disabling a patient does not prevent cleanup by an eligible issuing gateway. Gateway eligibility is checked at every mutation, including facility activity and the exact credential-expiry boundary. There is no category-code catalogue in the current design, so all `uint16` categories are accepted, including zero; category does not confer authority.

Controller errors added for this lifecycle: `IneligibleParticipant(account, role)`, `InvalidRecordId()`, `InvalidCiphertextHash()`, `RecordAlreadyExists(recordId)`, `RecordNotFound(recordId)`, `RecordInactive(recordId)`, and `WrongFacility(expected, actual)`. Internal helpers centralize participant eligibility, record existence, and issuing-gateway checks. Unknown-record deactivation reports `RecordNotFound` before caller checks; getters already expose existence.

Record lifecycle methods register and retire metadata only. Normal medical reads can now be authorized by the consent methods below; actual clinical payloads, keys, integrity verification, and delivery remain off-chain responsibilities.

### Normal consent and read authorization

`NORMAL_MODE()` is **0** and `EMERGENCY_MODE()` is **1**. Numeric signatures and existing event payloads are preserved. Every consent is for one clinician wallet and one record; no facility equality between the clinician and issuing facility is required. Multiple consents may coexist, each with an independent ID and revocation flag. A new consent never restores a revoked ID. Consent expiry is exclusive (`block.timestamp < expiresAt`); it may outlast credentials, but every read rechecks current credentials.

For normal mode, the shared `_canRead` policy requires existing matching consent/record ownership, unrevoked consent, unexpired time, active record, eligible patient and clinician, and active issuing facility. Clinician eligibility also checks the clinician's current facility. An eligible caller or admin cannot bypass scope or become the named doctor merely by holding a role. Unknown modes return false. Emergency mode follows the separate grant conditions described below, sharing the same current credential/record checks. Registry call failures propagate as errors and never become approval.

`canRead` is a public policy query, not wallet authentication or a permission to obtain data. It does not depend on the querying account and does not check a gateway. `authorizeAccess` additionally requires the calling gateway's current eligibility and issuing-facility affiliation. It rechecks the read policy during transaction execution, not an earlier cached query. Gateways must later authenticate the clinician wallet, await a successful final receipt, recheck current access, verify ciphertext, and enforce controlled delivery.

Only a successful authorization consumes `accessId`. IDs are nonzero and unique across records, grants, and gateways within this controller instance; each distinct read needs a new ID. Reverts leave no persistent authorization event. `AccessAuthorized` records access ID, record, patient, clinician, gateway, mode, grant ID, and block timestamp; it does not prove delivery or that the doctor read the payload.

The original patient can revoke after patient role removal, credential expiry, record deactivation, or facility shutdown. This is an access-removing operation and does not permit new grants or reads. Consent ownership, timestamps, and scope are retained. Unknown IDs and repeated revocations are rejected.

Additional errors: `InactiveFacility(facilityId)`, `NotRecordOwner(recordId, account)`, `InvalidConsentExpiry(expiresAt)`, `ConsentNotFound(consentId)`, `NotConsentOwner(consentId, account)`, `ConsentAlreadyRevoked(consentId)`, `InvalidAccessId()`, `AccessIdAlreadyUsed(accessId)`, and `ReadAccessDenied()`. Clients may use `canRead` for a current allow/deny result; detailed UI diagnosis must also read current consent/record/registry metadata. Transaction authorization reports generic `ReadAccessDenied` after gateway/access-ID validation when the shared policy fails.

### Pending emergency requests and request binding

The requesting clinician and patient must both be currently eligible. The requesting facility is derived from the clinician's registry entry, while records may come from multiple active issuing facilities. Every record must exist, be active, and belong to that patient. As with record registration, requiring patient eligibility makes the design's registered-patient requirement explicit and stricter: inactive, expired, or role-revoked patients cannot be used to create new requests.

Record IDs must be nonzero and strictly ascending by their numeric bytes32 value; duplicate or unordered input is rejected, never silently sorted. Scope contains 1–20 records and cannot be changed after creation. Encounter ID and evidence commitment are nonzero bytes32, reason is a nonzero uint16, and requested duration is 1–900 seconds. These checks validate request structure, not whether an emergency is clinically true. A nonzero reason code is not a clinical assessment or oracle approval.

Each successful request receives a fresh increasing ID. Repeated equivalent requests are separate requests with separate hashes; submission alone never activates access. Invalid requests leave no metadata/scope and do not consume an ID. `createdAt` is block time and `decisionDeadline = createdAt + 120`. A timestamp that would overflow the uint64 deadline is rejected. Activation, grant expiry, and attestation fields remain zero.

Stored request statuses are `PENDING=0`, `REJECTED=1`, `ACTIVE=2`, and `CLOSED=3`. Effective status additionally includes `EXPIRED=4`. Pending requests become effectively expired at `block.timestamp >= decisionDeadline` without a cleanup transaction or expiry event; stored status and historical fields remain unchanged. Active grants likewise expire effectively at `expiresAt`. Effective status describes lifecycle/time, not current credential eligibility. Requests can now become active or rejected; explicit closure awaits Chunk 5.

The array returned by `getRequestRecords` is bounded by 20; the contract also stores membership for constant-time emergency scope checks during reads. `getRequest` retains `exists=false` behavior for unknown IDs, while scope/effective-status queries reject unknown IDs. No global history enumeration is added.

Request hash is **keccak256 of `abi.encode(binding)`**, where `binding` is one dynamic tuple in this exact order:

```text
(uint256 chainId, address controller, uint256 requestId,
 address patient, address clinician, bytes32 requesterFacilityId,
 bytes32 encounterId, bytes32[] recordIds, uint16 reasonCode,
 bytes32 evidenceCommitment, uint64 requestedDuration, uint64 decisionDeadline)
```

This is a single tuple argument, including its ABI dynamic offset, not flattened arguments, packed encoding, JSON hashing, or EIP-712. All fields above are bound. The ordered record list is included directly. Chain ID and controller address prevent reuse across domains. Hashes do not change when credentials/facilities change or time passes; future approval must separately recheck current eligibility.

`smart-contract/integration/request-hash.ts` exports `hashEmergencyRequest`, `RequestHashInput`, and `requestHashParameters`. It is a pure viem utility without environment/signers. Integer IDs/times/duration use bigint, reason code uses a number, addresses use EVM address strings, and IDs/commitments use bytes32 hex strings. It validates widths/nonzero fields/bounds/order and never mutates input. Consumers must load the actual on-chain request and scope before recomputing; they must not infer the assigned request ID or block-derived deadline from form input.

Fixed reference vectors in both Solidity and TypeScript tests use chain 1337; controller/patient/clinician addresses consisting of repeated bytes `11`/`22`/`33`; facility/encounter/evidence bytes32 consisting of repeated bytes `44`/`55`/`66`; request ID 1; reason 7; duration 900; deadline 1120. With the single record ID uint256(10) encoded as bytes32, hash is `0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652`. With IDs 10 through 29 inclusive, hash is `0x7b5057334a9afe14d62740bb842110d11c6ad6295c295b51b88577a654024239`.

Request-specific errors: `InvalidRecordCount(count)`, `InvalidRecordOrder(previous, current)`, `RecordPatientMismatch(recordId, expected, actual)`, `InvalidEncounterId()`, `InvalidReasonCode()`, `InvalidEvidenceCommitment()`, `InvalidEmergencyDuration(duration)`, `InvalidRequestTimestamp()`, and `RequestNotFound(requestId)`, in addition to shared eligibility/record/facility errors.

### Oracle resolution and emergency read authorization

`resolveEmergency(requestId, approved, requestHash, observedAt, validUntil)` requires an existing request, an eligible oracle affiliated with its stored requesting facility, stored status PENDING, execution strictly before its decision deadline, and the exact stored request hash. Both positive and negative decisions enforce these checks and the timestamp rules below. Repeating a decision cannot reopen, extend, or overwrite an active/rejected request.

Timestamp acceptance is `observedAt <= block.timestamp < validUntil`, age `block.timestamp - observedAt <= 60`, and validity window `0 < validUntil - observedAt <= 60` seconds. Ordering checks precede subtraction, so malformed times fail with a named error rather than arithmetic underflow. Combined constraints mean an observation exactly 60 seconds old cannot still be valid under a maximum 60-second window. Fresh observations may predate request creation; the original design does not require otherwise. Clinical freshness comes from actual assessment time, not response-fetch time.

Before approval, the contract rechecks the clinician's current eligibility and original requesting-facility affiliation, patient eligibility, and every scoped record's activity, ownership, and issuing facility. Approval activates at execution block time and sets `expiresAt = activatedAt + requestedDuration`, rejecting uint64 overflow. Rejection leaves activation/expiry zero and makes the request terminal REJECTED; it can still remove the pending request after participant deactivation or affiliation changes, provided the resolving oracle remains eligible at the original facility and supplies a valid bound decision.

The contract computes and stores the attestation hash, rather than accepting a caller-supplied commitment:

```text
keccak256(abi.encode(
  uint256 chainId, address controller, uint256 requestId, bytes32 requestHash,
  bool approved, uint64 observedAt, uint64 validUntil
))
```

These are seven flat ABI arguments (all static). The request hash transitively binds patient, doctor, facilities/scope, encounter, reason, evidence commitment, duration, and deadline. There is no second attestation signature: the oracle's transaction signature supplies sender identity; the contract enforces its role/facility and the event identifies that oracle. This does not prove that off-chain clinical facts are true.

`smart-contract/integration/attestation-hash.ts` exports the pure `hashEmergencyAttestation`, `AttestationHashInput`, and `attestationHashParameters`. It checks integer widths, boolean/address/hash format, and a 1–60 second window. It cannot establish current chain freshness, request status, role authority, or clinical truth; those require the actual chain and later worker. Fixed vectors use chain 1337, controller `0x1111111111111111111111111111111111111111`, request ID 1, request hash `0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652`, observedAt 1000, validUntil 1060. Approval hashes to `0xb12cb5883140d1c0368649fe0ce0e70e2899b7358ddfe8b763cff27518417549`; rejection hashes to `0x3434a6118639de46ef1c823bfe7083550e2797d73216e8dbad812b7b9713755f`.

Emergency mode reads require an active existing grant strictly before expiry, its named clinician, the matching patient, and membership of the selected record. The clinician must remain affiliated with the original requesting facility, and common read checks require current patient/clinician eligibility, active record, and active issuing facility. Only the eligible issuing gateway may record authorization. A deactivated scoped record blocks reads of that record; other eligible records retain their own checks. Attestation validity only controls decision acceptance, not the lifetime of the resulting grant.

Normal consent and emergency grants are independent even when their numeric IDs coincide. Revoking normal consent does not close an emergency grant. Access-ID replay protection is shared across both modes. Revoking an oracle prevents its future decisions but does not retroactively erase previously accepted grants; explicit closure is Chunk 5. Credential/facility restoration may restore an otherwise unexpired grant, while changing clinician affiliation denies the original emergency context. No API, oracle worker, clinical validation, wallet-authenticating HTTP gateway, or data delivery is implemented by these contract methods.

Additional resolution errors are `RequestNotPending(requestId)`, `RequestDeadlinePassed(requestId)`, `RequestHashMismatch(requestId)`, and `InvalidAttestationTimestamps()`, alongside shared eligibility/facility/record errors and `InvalidRequestTimestamp()` for grant-expiry overflow.

Policy constants: **15 minutes** emergency duration, **60 seconds** attestation age, **120 seconds** request TTL, **20 records** per request, and **24 hours** review target. Request bounds, attestation validation, and activation-based grant expiry are enforced. Review timing and explicit closure await Chunk 5. These are prototype parameters, not clinical standards.

## Commands

Run from `smart-contract/`:

```sh
npm ci
npm run compile
npm test
```

| Command | Action |
| --- | --- |
| `npm run compile` | Compile contracts and export ABI arrays to `abi/`. |
| `npm run typecheck` | Check TypeScript. |
| `npm test` | Compile, type-check, and run contract/deployment tests. |
| `npm run test:contracts` | Run Solidity tests on Hardhat. |
| `npm run test:deployment` | Test deployment, verification, reuse, and recovery on disposable Hardhat EVMs. |
| `npm run test:integration` | Check request/attestation vectors, field/domain sensitivity, encoder validation, signed pending requests, cross-facility oracle resolution, and emergency authorization/expiry. |
| `npm run export:abi` | Export ABIs from existing build artifacts. |
| `npm run deployer:address` | Print the configured deployer's public address. |
| `npm run deploy:besu` | Compile, deploy or verify/reuse contracts, and write public deployment metadata. |
| `npm run deploy:besu -- --redeploy` | Create new contracts and replace deployment metadata. |

Local tests require no Besu node or private key. Compilation produces expected unused-parameter warnings for stubs.

Contract tests check registry permissions, invalid inputs, role separation, facility status, and credential expiry, including the exact expiry boundary. Controller tests check registry wiring, metadata reads, constants, record lifecycle, normal consent/authorization policy/events, and rejection by every remaining stub. `ControllerFixture.sol` supplies two facilities, two patients, clinicians, gateways, oracles, and an auditor for policy tests. Deployment/integration tests exercise the CLI's deployment helper and a signed normal-access lifecycle against isolated Hardhat chains with temporary signers and output files.

## Configuration and deployment

| Variable | Value |
| --- | --- |
| `BESU_CHAIN_ID` | `1337` (default and required chain ID). |
| `BESU_RPC_URL` | `http://127.0.0.1:8545` by default. |
| `DEPLOYER_PRIVATE_KEY` | Throwaway local deployment account key: `0x` plus 64 hex characters. |

Environment precedence: process environment, repository-root `.env`, then `smart-contract/.env`. The Hardhat network is named `besu`; the CLI uses viem with the same configuration.

Deployment requires a running private chain and an approved, funded local account:

1. Set the deployment key in the trusted environment or an ignored `.env` file.
2. Run `npm run deployer:address` and use its public address for infrastructure account approval and funding.
3. Start the chain using the infrastructure setup and confirm chain ID 1337.
4. Run `npm run deploy:besu` from `smart-contract/`.

Containerized callers use the infrastructure's RPC hostname rather than their own localhost. The deployment account becomes the registry's initial admin. Transaction fees are estimated through the RPC; the script does not assume zero fees.

Deployment runs registry first, then controller. It verifies chain/genesis identity, compiled bytecode, transaction receipts and constructor inputs, signer configuration, and registry wiring before reusing saved addresses. Public outputs:

- [Deployment metadata](../smart-contract/deployments/README.md): `smart-contract/deployments/1337.json`.
- ABI arrays: `smart-contract/abi/ParticipantRegistry.json` and `smart-contract/abi/MedicalAccessController.json`.

Consumers read addresses from `contracts.*` and use the matching ABI arrays. Wallet/RPC connections must match chain ID 1337 and contain code at those addresses. Infrastructure account allowlisting and registry application roles are separate controls. Private keys stay in the trusted deployment environment.

An address identifies the deployed instance; its ABI describes callable methods, arguments, return values, errors, and events. Together, these files give the frontend and service processes a consistent contract interface. Event consumers use the same ABI exports to decode registry and controller logs.

## Recovery

Retries resume `1337.pending.json` before checking completed metadata. The `1337.lock` file prevents concurrent deployments; remove a stale lock only after confirming the process has stopped.

The checkpoint records submitted transaction hashes and confirmed contract addresses. A retry can wait for an existing receipt or reuse a verified registry before continuing with the controller. A completed deployment is reused only when its chain, artifacts, transactions, and wiring still match; a mismatch stops the command rather than silently replacing contracts.

Use explicit `--redeploy` after a chain reset, configuration/artifact change, or reverted deployment. It creates new contracts without resetting the chain; consumers must reload their addresses. If a process stops between transaction submission and checkpoint writing, inspect the deployer's transaction history before retrying.

## Validation

Historical foundation verification on **13 November 2026** included Besu deployment/reuse and chain acceptance; see [the recorded chain results](private-chain.md#pemeriksaan-dan-hasil). That supersedes the earlier November 4 observation that Besu was unavailable.

Record-lifecycle verification on **26 November 2026**, using Node **24.14.0** on Windows: `npm --prefix smart-contract test` passed compilation/ABI export, TypeScript checking, **36 Solidity tests**, and **8 deployment tests**. There are 15 new record-lifecycle tests, including **256 gateway-expiry fuzz runs**, alongside the existing registry expiry fuzz test (256 runs). Unused-parameter warnings are expected from the ten remaining controller stubs.

| Requirement | Evidence in `smart-contract/test/RecordLifecycle.t.sol` | Observed result |
| --- | --- | --- |
| FR-01 / NFR-02: current eligibility and role restrictions | `testAllNonGatewayRolesCannotMutateRecords`, `testInactiveRevokedAndExpiredGatewayCannotMutate`, `testRejectsInactiveRevokedAndExpiredPatientCredentials` | Passed; admin-only, clinician, oracle, auditor, patient, and unknown accounts cannot act as gateways |
| FR-02: metadata registration and issuing facility | `testRegistersMetadataAndEmitsIssuingFacility`, `testDerivesFacilityForEachGatewayAndRetainsCategory` | Passed; state and registration event match patient/hash/facility |
| FR-02: invalid identifiers and immutable identity | `testRejectsZeroRecordAndCiphertextHashWithoutWritingMetadata`, `testRejectsUnregisteredZeroAndWrongRolePatients`, `testRejectsDuplicateAcrossFacilitiesAndAfterDeactivation` | Passed; invalid attempts do not create or overwrite records |
| FR-02: issuer-only deactivation and preserved history | `testDeactivationPreservesMetadataAndEmitsEvent`, `testWrongFacilityAndReaffiliatedGatewayCannotDeactivate`, `testAnotherEligibleGatewayOfIssuerCanDeactivate`, `testRejectsUnknownAndAlreadyInactiveRecords` | Passed; facility-bound authority and metadata retention |
| FR-01 / NFR-06: exact credential expiry and facility shutdown | `testFuzzGatewayCredentialExpiryBoundary`, `testInactiveFacilityBlocksRegistrationAndDeactivation` | Passed; mutation denied at expiry, restored after valid renewal/reactivation |
| Safe cleanup after patient deactivation | `testPatientDeactivationDoesNotBlockRecordCleanup` | Passed; eligible issuer can still deactivate |

Normal-consent verification on **26 November 2026**: compile/ABI export and TypeScript checking passed; **59 Solidity tests** passed, including 23 new consent tests and 256 generated consent-expiry cases. The existing registry and gateway expiry fuzz tests also each ran 256 cases. **9 deployment/integration tests** passed, including a new signed-transaction registration → consent → authorization → revocation → reverted authorization → new consent scenario. It checks the complete decoded authorization payload, retained revoked metadata, a reverted receipt with zero logs, and reuse of an ID from a denied attempt. Expected unused-parameter warnings remain for six emergency/review stubs.

| Requirement | Evidence in `smart-contract/test/NormalConsent.t.sol` | Observed result |
| --- | --- | --- |
| FR-03: owner-only, scoped, future consent | `testGrantStoresScopeAndEmitsConsentForCrossFacilityDoctor`, `testOnlyRecordOwnerCanGrantNotAdminOrServiceRoles`, `testGrantRejectsExpiryNowAndInPastWithoutConsumingIds`, `testConsentCannotAuthorizeAnotherExistingRecordOrPatient` | Passed; exact metadata/event, cross-facility doctor support, no ID allocation on failed grant |
| FR-04: irreversible revocation with history | `testRevocationEmitsEventPreservesMetadataAndDeniesFutureAccess`, `testOnlyOriginalPatientMayRevokeAndCannotRevokeTwice`, `testPatientCanRevokeAfterAllCredentialsAndRecordBecomeInactive`, `testNewConsentNeverReactivatesRevokedConsentOrOtherGrant` | Passed; only the original patient removes consent; old IDs stay revoked |
| FR-01 / NFR-02: current role/credential/facility checks | `testExistingConsentChecksCurrentPatientStatusAndRole`, `testExistingConsentChecksCurrentClinicianStatusRoleAndFacility`, `testRecordDeactivationAndIssuerShutdownDenyExistingConsent`, `testInactiveRevokedExpiredAndReaffiliatedGatewayCannotAuthorize` | Passed; stale role membership does not permit access; query and gateway checks remain distinct |
| Contract side of FR-10/FR-12, NFR-03: issuer gateway and audit/replay | `testOnlyIssuingGatewayCanAuthorizeDespitePublicReadQuery`, `testAuthorizationEmitsCompleteAuditPayloadAndAllowsDistinctReads`, `testZeroAndReplayedAccessIdsAreRejectedGlobally`, `testDeniedAuthorizationDoesNotConsumeAccessId` | Passed; shared policy, nonzero global IDs, complete event, fail-closed transactions |
| NFR-06: exclusive expiry | `testFuzzConsentExpiryQueryAndAuthorizationAgree` | Passed; queries and transactions allow before expiry and deny exactly at/after expiry across 256 generated cases |

Emergency-request verification on **26 November 2026**: `npm --prefix smart-contract test` passed compile/ABI export, TypeScript, **76 Solidity tests**, **9 deployment/integration tests**, and **5 request-hash/integration tests**. The 17 new Solidity tests include 256 pending-expiry fuzz cases and fixed single-/20-record hash vectors. Signed TypeScript scenarios compare actual stored hashes and event payloads to the helper for 1- and 20-record requests, inspect bounded scope, and check status before, at, and after the deadline. Field/domain sensitivity covers every hash field. Four emergency-resolution/closure/review methods remain explicit reverting stubs.

| Requirement | Chunk 3 evidence | Observed result |
| --- | --- | --- |
| FR-05: eligible requesting clinician, patient, immutable request data | `EmergencyRequest.t.sol`: `testRequestStoresScopeMetadataAndEmitsPendingEventWithoutConsent`, `testOnlyEligibleCliniciansCanRequest`, credential/patient denial tests | Passed; requesting facility comes from registry, request starts pending with zero activation fields |
| FR-05 / NFR-08: bounded canonical record scope | `testTwentySortedRecordsAcrossFacilitiesAreAccepted`, `testRejectsEmptyAndOversizedScope`, `testRejectsZeroDuplicateAndDescendingIdsWithoutSilentSorting`, invalid-record/partial-scope tests | Passed; 1–20 records, cross-facility records supported, invalid requests do not consume IDs |
| FR-05 / FR-07 prerequisite: submission does not grant access | `testPendingRequestNeverAuthorizesEmergencyReadsOrChangesConsent` | Passed; existing normal consent is independent and emergency reads remain denied |
| NFR-06: exclusive pending deadline | `testFuzzPendingExpiryBoundary`, `testDeadlineUint64OverflowIsRejectedWithoutWrapping`; signed TypeScript deadline checks | Passed; exact boundary and no cleanup transaction; stored pending history retained |
| NFR-07 prerequisite: request and domain binding | `testFixedSingleAndTwentyRecordHashVectors`; `test/request-hash.test.ts` fixed vectors, every-field sensitivity, signed on-chain hash comparison | Passed; same single-tuple encoding across Solidity/TypeScript and domain-sensitive hashes |

Oracle-resolution verification on **26 November 2026**: `npm --prefix smart-contract test` passed compile/ABI export, TypeScript, **102 Solidity tests**, **9 deployment tests**, and **9 request/attestation integration tests**. The 26 new Solidity tests include fixed decision vectors and two fuzz tests (256 cases each) for grant expiry and attestation-window acceptance. Signed TypeScript integration approves a 20-record request across requesting/issuing facilities, compares stored/event attestation hashes to the helper, verifies full access events, and checks reverted receipts have no logs for pending/out-of-scope/replayed/expired authorizations and wrong-facility/repeated decisions. A negative decision and its stored hash are also verified.

| Requirement | Chunk 4 evidence | Observed result |
| --- | --- | --- |
| FR-07 / NFR-02: eligible requesting-facility oracle, matching pending request | `EmergencyResolution.t.sol`: caller/facility/credential tests, hash mismatch/replay tests, deadline tests | Passed; only an eligible oracle of the stored requesting facility can decide once before the deadline |
| FR-07: approval rechecks and negative terminal outcome | clinician/patient/scope recheck tests; `testNegativeDecisionIsTerminalWithoutActivationOrReadAccess` | Passed; invalid approval leaves pending state unchanged; valid rejection never opens reads |
| NFR-07: fresh, bound attestation | `testFutureStaleExpiredReversedAndOverlongAttestationsFailClosed`, `testFuzzAttestationAcceptanceUsesExactWindowAndFutureBounds`, fixed vectors and TypeScript every-field sensitivity | Passed; future/stale/expired/malformed windows rejected, all seven hash fields bound |
| FR-08 / partial FR-09 / NFR-06: scoped, current, time-limited reads | doctor/scope/current-credential/record/facility tests, `testFuzzGrantExpiryQueryAndAuthorizationAgree`, signed expiry checks | Passed; allow before expiry, deny at/after it without cleanup; stored grant history retained |
| FR-12 / NFR-03: authorization events and cross-mode replay protection | full event test, cross-mode replay test, signed cross-facility scenario | Passed; normal and emergency grants are independent but access IDs are globally unique per controller |

The public ABI has been regenerated. The existing `deployments/1337.json` still describes the historical skeleton deployment; this changed controller has **not** been deployed to Besu during Chunks 1–4. Deployment verification will reject reuse against changed artifacts. Explicit deployment/reverification belongs to the contract-release chunk; no ledger reset or existing deployment replacement was performed here.

FR-11's ciphertext hash metadata is available, but actual integrity checking remains a future gateway task. These results establish normal and oracle-resolved emergency contract authorization, not end-to-end clinical validation, explicit closure/review, medical-data delivery, complete confidentiality, or application latency.
