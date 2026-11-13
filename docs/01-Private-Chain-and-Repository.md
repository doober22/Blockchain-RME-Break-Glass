# Role 1 — Repository and Private-Chain Infrastructure

## Prompt

You are the infrastructure engineer for a three-person IF4035 Blockchain project. Implement the initial repository structure and runnable private blockchain. Work directly in the provided repository; inspect its instructions and existing files before making changes.

### Project context

We are building a decentralized medical-record system with Break-Glass Access Control. Normal access depends on patient consent. Emergency access will be read-only, limited to selected records, temporary, verified using an off-chain hospital-context oracle, and reviewed afterward. SATUSEHAT already provides emergency consent; our contribution concerns decentralized authorization and auditability.

The agreed stack is Besu, a private permissioned EVM network, QBFT, Solidity, Hardhat, TypeScript, viem, MetaMask, and Docker Compose. Use synthetic data only. This milestone covers the repository, private chain, deployable contract skeleton, and draft README/setup—not the complete application.

### Ownership

You own:

- Root repository structure and shared orchestration scripts.
- `infrastructure/`, including Docker Compose, genesis generation, Besu configuration, and chain health checks.
- Root `.gitignore`, root `.env.example`, and any root task runner/package scripts.
- `docs/private-chain.md`.

Role 2 owns `smart-contract/`. Role 3 owns `README.md`, `frontend/`, `oracle/`, and the other documentation. Create the required directories if missing, but do not overwrite their contents. Preserve an existing LICENSE; if none exists, flag the team's license decision rather than silently choosing a license.

### Shared integration agreement

- Required root directories: `frontend/`, `smart-contract/`, `oracle/`, `docs/`.
- Local chain ID: `1337`.
- Host RPC URL: `http://127.0.0.1:8545`.
- Root environment keys: `BESU_CHAIN_ID`, `BESU_RPC_URL`, and `DEPLOYER_PRIVATE_KEY`; the example private-key value must be empty or an obvious placeholder.
- Use four validator containers and one non-validator RPC container. Initial block period: two seconds.
- Contract deployment output belongs to `smart-contract/deployments/1337.json`; Role 2 produces it.
- Root commands should delegate to independent subproject scripts; avoid introducing a workspace configuration that changes another role's package ownership.

If the repository already establishes incompatible values, identify the conflict and coordinate a single agreement before changing consumers.

### Implement

1. Inspect existing code, instructions, and package conventions. Create only the missing required structure. Do not replace working project configuration unnecessarily.
2. Configure a pinned Besu container version, four QBFT validators, and a separate RPC node. Generate genesis and validator material reproducibly. Consult the selected version's official documentation and verify any configuration flags used.
3. Generate node keys locally and exclude secrets, data directories, caches, and runtime logs from git. Provide a documented way to create/fund a development deployer without committing private keys. Keep public addresses and secrets clearly separated.
4. Configure explicit node and account permissioning consistently across controlled nodes. Different chain IDs alone are insufficient. Explain how approved wallet, deployer, oracle, and gateway addresses enter the account allowlist. Ensure onboarding does not require an already-authorized transaction from an unauthorized account.
5. Bind the host-facing RPC to loopback by default, enable only necessary RPC namespaces, and configure allowed origins deliberately. Do not expose privileged node-management RPC methods broadly merely to simplify setup.
6. Provide commands to initialize, start, inspect, stop, and restart the network. Any destructive chain reset must require an explicit command or flag and be described as deleting local state; never run it automatically.
7. Provide a health-check script that verifies `eth_chainId`, advancing block height, and a four-address QBFT validator set. Print public diagnostics, not private keys.
8. Document container-to-container RPC addressing separately from the host URL so future oracle services do not use their own `localhost` by mistake.

### Validation and acceptance criteria

- A clean setup starts four validators plus the RPC node.
- Chain ID is 1337; blocks advance; the validator list has four entries.
- Approved accounts can reach the intended transaction path. Demonstrate rejected unauthorized submission through the configured controlled RPC path, without claiming that local permissioning alone prevents every malicious node from leaking ledger data.
- Stopping one validator still allows block production; report the observation. If resource constraints prevent this test, say so explicitly.
- Stop/start preserves state; reset is separate and explicit.
- No generated private key or secret is tracked in git.
- README authors can reproduce the exact commands from `docs/private-chain.md`.

### Handoff

Return changed files, exact commands tested, results, limitations, pinned versions, public network configuration, and required environment variables. Give Roles 2 and 3 the start/stop/health commands and the approved-account onboarding procedure. Do not claim that Docker containers on one host establish real multi-organization availability.
