# Role 3 — README, Setup Guide, and Integration Scaffolding

## Prompt

You are the documentation and integration engineer for a three-person IF4035 Blockchain project. Produce an accurate draft README and minimal integration scaffolds. Work directly in the repository; inspect its instructions and actual scripts before documenting commands.

### Project context

Our project upgrades a decentralized medical-record system with Break-Glass Access Control. Normal access requires patient consent. Emergency access will be limited to selected records, read-only, short-lived, backed by an oracle's hospital-context verification, and reviewed afterward. SATUSEHAT already offers emergency consent; the contribution is decentralized authorization and a shared audit trail.

The stack is Besu, private permissioned EVM blockchain, QBFT, Solidity, Hardhat, TypeScript, viem, MetaMask, and Docker Compose. All patient, encounter, and record data are synthetic. This milestone covers required repository structure, a private chain, contract skeleton, and draft description/setup. Do not present the complete dApp or oracle as implemented.

### Ownership

You own:

- Root `README.md`.
- `frontend/` and `oracle/` minimal scaffolds.
- `docs/setup.md`, `docs/architecture.md`, and `docs/integration-contract.md`.

Role 1 owns infrastructure, root orchestration, root environment template, `.gitignore`, and `docs/private-chain.md`. Role 2 owns `smart-contract/` and `docs/smart-contracts.md`. Coordinate necessary changes to their files instead of overwriting them.

### Shared integration agreement

- Required directories: `frontend/`, `smart-contract/`, `oracle/`, `docs/`.
- Besu chain ID: `1337`; host RPC: `http://127.0.0.1:8545`.
- Shared environment keys: `BESU_CHAIN_ID`, `BESU_RPC_URL`, `DEPLOYER_PRIVATE_KEY`. The deployer secret belongs only in the trusted deployment environment, never browser configuration.
- Contract scripts within `smart-contract/`: `compile`, `test`, `deploy:besu`.
- Addresses: `smart-contract/deployments/1337.json`, with `chainId`, `contracts.ParticipantRegistry`, `contracts.MedicalAccessController`, and `deploymentTransactions`.
- ABIs: `smart-contract/abi/`.
- Take actual chain start/stop/health commands from Role 1, rather than inventing them.

### Implement the README draft

1. Write the project description and explanation in Bahasa Indonesia, using common English technical terms consistently: smart contract, access control, patient consent, break-glass, oracle, audit trail, integrity, latency, least privilege, on-chain/off-chain, deployment, and wallet.
2. Explain the problem, proposed contribution, normal/emergency access flows, and why a private consortium blockchain is used. Avoid claiming the prototype improves on SATUSEHAT's performance or security without comparative measurements.
3. Add a milestone-status table with three explicit states: Implemented and verified, Implemented but unverified, Planned. Derive each status from files and command results. A skeleton with reverting methods is not a completed authorization mechanism.
4. Document the required repository tree, each directory's purpose, and the three roles' ownership. Verify a LICENSE exists or record the team's unresolved licensing choice; do not invent a license.
5. List actual prerequisites and pinned/compatible versions, then give a clean-clone setup sequence: environment preparation, chain initialization/start, health check, contract dependency installation, compile/tests, deployment, and address/ABI verification.
6. Explain MetaMask configuration: network name, RPC URL, chain ID 1337, local native-currency label, and approved-account onboarding/funding. Use only throwaway development accounts. Do not ask users to paste secrets into frontend configuration or commit keys.
7. Include stop/restart and explicit reset instructions from Role 1. State which command deletes local chain data. Cover wrong network, RPC unavailable, unauthorized account, missing development balance, incompatible dependencies, and stale deployment addresses after reset.
8. Include startup instructions for oracle/frontend only if runnable. Otherwise label them Planned and explain the next integration step. Include demo/video and installation/use-case documentation status without fabricating URLs.

### Minimal scaffolding

Create useful placeholders for `frontend/` and `oracle/` without expanding this task into a full implementation:

- Each directory needs a short README describing responsibility, inputs, outputs, and implementation status. Add TypeScript types or example configuration only when they make the next handoff concrete.
- Define a frontend address/ABI consumption convention compatible with Role 2's artifact. Validate chain ID before use. Never bundle deployment, oracle, gateway, or encryption secrets in browser code.
- Define the oracle's future event-to-API-to-transaction flow. The worker will listen to finalized emergency requests, query an independently maintained synthetic hospital API, and submit an authorized decision. A doctor's self-declared emergency in the frontend is insufficient.
- Document the proposed mock endpoint `GET /api/v1/encounters/{encounterId}/emergency-context` and JSON fields: `encounterId`, `patientWallet`, `clinicianWallet`, `facilityId`, `encounterActive`, `emergency`, `patientUnableToConsent`, `clinicianAssigned`, `evidenceCommitment`, `observedAt`, `validUntil`.
- Identify it as a project mock endpoint, not a SATUSEHAT endpoint. Use no real patient information. Record future requirements for schema validation, authenticated API access, request binding, freshness, bounded retries, and idempotency. Do not claim those features are implemented by documentation alone.

### Architecture and limitations

Use a compact Mermaid diagram in `docs/architecture.md` covering frontend/wallet, RPC/private chain/contracts, oracle and mock hospital API, facility gateway, encrypted storage/key service, and audit indexer. Mark planned components clearly. Explain that validators check rules rather than medical truth, and that ciphertext storage, keys, and clinical facts remain off-chain. Four local validator containers simulate consortium participants; they do not demonstrate independent organizational hosting. Authorization events do not prove successful record delivery.

### Validation and acceptance criteria

- Re-run the documented safe setup/compile/test commands in a clean environment when possible, and record observed results.
- Verify relative links, named files, environment keys, deployment schema, and package-script names against the repository.
- Separate host and container RPC addresses. Do not run destructive reset without an explicit task requirement.
- A teammate can identify what runs now, what is stubbed, and what remains planned from the README alone.
- Clearly label any blocked setup step; do not fill gaps with fabricated successful output.

### Handoff

Return changed files, the final README, validation results, remaining TODOs, and any integration inconsistencies requiring action from Roles 1 or 2. Keep this milestone's scope explicit and ensure the README's commands match their delivered code.
