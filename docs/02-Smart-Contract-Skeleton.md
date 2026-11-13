# Role 2 — Smart-Contract Skeleton and Deployment

## Prompt

You are the smart-contract engineer for a three-person IF4035 Blockchain project. Implement a compilable, testable, deployable contract skeleton. Work directly in the provided repository; inspect repository instructions and existing code first.

### Project context

We are building a decentralized medical-record system with Break-Glass Access Control. Patients control normal consent. Emergency access will require a hospital-context oracle attestation and will be read-only, restricted to selected records, short-lived, and subject to subsequent audit. Blockchain stores authorization metadata and audit events; encrypted records, medical evidence, and encryption keys remain off-chain. SATUSEHAT already supports emergency consent; our research concerns decentralized enforcement and accountability.

The agreed stack is Besu/QBFT, EVM, Solidity, Hardhat, TypeScript, viem, MetaMask, and Docker Compose. This milestone is a contract skeleton and deployment foundation—not the full access-control implementation.

### Ownership

You own `smart-contract/`, its package manifest/lockfile, Hardhat configuration, contracts, tests, deployment scripts, generated public deployment metadata, and `docs/smart-contracts.md`.

Role 1 owns root orchestration and private-chain infrastructure. Role 3 owns README, frontend/oracle scaffolds, and integration documentation. Do not edit their files without coordinating.

### Shared integration agreement

- Required root directories: `frontend/`, `smart-contract/`, `oracle/`, `docs/`.
- Besu network name in Hardhat: `besu`.
- Chain ID: `1337`; host RPC: `http://127.0.0.1:8545`.
- Environment keys: `BESU_CHAIN_ID`, `BESU_RPC_URL`, `DEPLOYER_PRIVATE_KEY`.
- Expose package scripts named `compile`, `test`, and `deploy:besu` within `smart-contract/`.
- Deployment artifact: `smart-contract/deployments/1337.json`.
- Artifact fields: `chainId`, `contracts.ParticipantRegistry`, `contracts.MedicalAccessController`, and `deploymentTransactions` containing both deployment transaction hashes.
- Export both contract ABIs under `smart-contract/abi/` for future viem consumers. Never include signer private keys in artifacts or logs.

### Implement

1. Select and pin a compatible supported Solidity compiler, Hardhat setup, TypeScript configuration, and OpenZeppelin Contracts version. Verify compatibility using official documentation. Preserve a working project toolchain when one already exists.
2. Build `ParticipantRegistry` with an explicit initial admin, role identifiers, facility/participant structs, mappings, and events. Application roles are PATIENT, CLINICIAN, AUDITOR, ORACLE, and GATEWAY. Keep service accounts separate from clinician accounts. Admin status must not imply permission to read medical records.
3. Implement enough registry behavior to exercise authorized registration, status changes, and eligibility checks. Define credential expiry and facility affiliation. Reject zero/unknown identifiers and unauthorized mutations. Distinguish admin-role management from ordinary participant onboarding.
4. Build `MedicalAccessController` with an immutable registry reference; record, consent, emergency-request, and review structures; status enums; bounded request-record membership; counters; and access-ID replay protection fields.
5. Define the planned interfaces and events listed below. Implement only the safe subset needed for deployment and meaningful smoke tests. Any unfinished authorization or mutation method must explicitly revert with a named error such as `NotImplemented()`; it must never silently succeed, issue a grant, or return permissive authorization. Document implemented versus stubbed behavior method by method.
6. Add an idempotent deployment workflow that verifies the chain ID, uses the configured deployer, deploys the registry followed by the controller, and exports addresses, transaction hashes, and ABIs. Reuse a prior deployment only after checking code exists and configuration matches; require an explicit redeploy option otherwise.
7. Coordinate the deployer's public address with Role 1's account allowlist/funding procedure. Do not commit development secrets or fund real public-chain accounts.

### Planned contract surface

- Registry: facility registration/activation; participant registration/update; role grant/revoke; `isEligible()` and metadata getters.
- Metadata and consent: `registerRecord()`, `deactivateRecord()`, `grantConsent()`, `revokeConsent()`, `canRead()`, `authorizeAccess()`.
- Break-glass: `requestEmergency()`, `resolveEmergency()`, `closeEmergency()`, `submitReview()`, effective-status/metadata getters, `isReviewOverdue()`.
- Events: registry changes, record registration/deactivation, consent grant/revocation, emergency request/resolution/closure/review, and `AccessAuthorized`.

Initial policy constants: emergency duration ≤15 minutes; attestation age ≤60 seconds; request deadline 120 seconds; ≤20 distinct records per request; review target 24 hours. These are configurable research assumptions fixed for this prototype deployment, not clinical standards.

Future oracle approval must bind request ID/hash, chain ID, contract address, decision, and observation/validity timestamps. Grant expiry is measured from activation; attestation freshness only controls when approval is accepted. Expiry must be checked on access without requiring a cleanup transaction. `AccessAuthorized` records authorization, not proof that a medical record was delivered. Solidity `private` does not make clinical information confidential.

### Validation and acceptance criteria

- Compile succeeds and both contracts deploy to the agreed Besu network.
- Tests cover admin-only registry mutations, invalid identifiers, role/credential eligibility, correct registry wiring, and at least one unfinished access-control path reverting safely.
- Where expiry logic is implemented, include exact-boundary tests; do not write tests claiming unfinished features work.
- Exported addresses contain deployed bytecode, match chain ID 1337, and match exported ABIs.
- If the private chain is unavailable, complete local compile/tests and report the Besu deployment as unverified rather than claiming success.

### Handoff

Provide changed files, exact tested commands/results, deployment artifact/schema, selected versions, and implemented-versus-stubbed methods. Tell Role 3 how to install, compile, test, deploy, and consume addresses/ABIs. Record security limitations and next implementation steps in `docs/smart-contracts.md`.
