# Smart contracts

Solidity contracts, ABI exports, tests, and deployment tooling for the RME private chain.

`ParticipantRegistry` manages who participates in the system and whether their credentials are valid. `MedicalAccessController` implements record registration/deactivation and holds the remaining medical-access data model, referencing that registry. Consent, emergency grants, and read authorization remain reverting stubs. The deployment tooling connects both contracts and exports their public interfaces for application services.

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
| `grantConsent()`, `revokeConsent()`, `canRead()`, `authorizeAccess()`, `requestEmergency()`, `resolveEmergency()`, `closeEmergency()`, `submitReview()`, `getEffectiveStatus()`, `isReviewOverdue()` | Stubs; all revert with `NotImplemented()`. |

The metadata getters return `exists=false` for unknown IDs. Callers must inspect that flag rather than treating default field values as a valid entry. The constructor checks that the registry address contains code; the deployment workflow additionally verifies the expected registry bytecode and controller reference.

Record IDs cannot be reused, including after deactivation or by a different facility. Patient, issuing facility, ciphertext hash, and category cannot be changed. Corrections require a new ID. Any eligible gateway of the issuing facility may deactivate a record; authority belongs to the facility rather than only the original registering wallet. Moving a gateway to another facility does not transfer the record's issuing facility.

Registration explicitly requires current patient eligibility, including credential expiry and active status, in addition to the design's registered-patient requirement. Deactivation does not require patient eligibility, so disabling a patient does not prevent cleanup by an eligible issuing gateway. Gateway eligibility is checked at every mutation, including facility activity and the exact credential-expiry boundary. There is no category-code catalogue in the current design, so all `uint16` categories are accepted, including zero; category does not confer authority.

Controller errors added for this lifecycle: `IneligibleParticipant(account, role)`, `InvalidRecordId()`, `InvalidCiphertextHash()`, `RecordAlreadyExists(recordId)`, `RecordNotFound(recordId)`, `RecordInactive(recordId)`, and `WrongFacility(expected, actual)`. Internal helpers centralize participant eligibility, record existence, and issuing-gateway checks. Unknown-record deactivation reports `RecordNotFound` before caller checks; getters already expose existence.

These methods register and retire metadata only. They neither verify ciphertext contents nor grant medical reads. Clinical payloads, keys, and integrity verification remain off-chain responsibilities.

Stored request statuses are `PENDING`, `REJECTED`, `ACTIVE`, and `CLOSED`. A separate effective-status enum includes `EXPIRED`. The request-record array and membership mapping describe record scope, while `usedAccessIds` reserves storage for access-ID replay tracking. The grouped stubs explicitly reject calls, including authorization queries, so the declared interface cannot issue access grants.

Policy constants: **15 minutes** emergency duration, **60 seconds** attestation age, **120 seconds** request TTL, **20 records** per request, and **24 hours** review target. These are prototype parameters; their enforcement belongs to the stubbed operations.

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
| `npm run export:abi` | Export ABIs from existing build artifacts. |
| `npm run deployer:address` | Print the configured deployer's public address. |
| `npm run deploy:besu` | Compile, deploy or verify/reuse contracts, and write public deployment metadata. |
| `npm run deploy:besu -- --redeploy` | Create new contracts and replace deployment metadata. |

Local tests require no Besu node or private key. Compilation produces expected unused-parameter warnings for stubs.

Contract tests check registry permissions, invalid inputs, role separation, facility status, and credential expiry, including the exact expiry boundary. Controller tests check registry wiring, metadata reads, constants, record lifecycle policy/events, and rejection by every remaining stub. `ControllerFixture.sol` supplies two facilities, two patients, clinicians, gateways, oracles, and an auditor for subsequent policy tests. Deployment tests exercise the same deployment helper used by the CLI against isolated Hardhat chains with temporary signers and output files.

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

The public ABI has been regenerated. The existing `deployments/1337.json` still describes the historical skeleton deployment; this changed controller has **not** been deployed to Besu during this chunk. Deployment verification will reject reuse against changed artifacts. Explicit deployment/reverification belongs to the contract-release chunk; no ledger reset or existing deployment replacement was performed here.

FR-11's ciphertext hash metadata is available, but actual integrity checking remains a future gateway task. These results do not establish consent, break-glass, medical-data delivery, complete confidentiality, or application latency.
