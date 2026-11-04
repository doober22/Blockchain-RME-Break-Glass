# Deployment metadata

Public contract addresses and deployment records for chain **1337**.

| File | Contents |
| --- | --- |
| `1337.json` | Verified deployment metadata. |
| `1337.pending.json` | Transaction hashes and addresses used to resume an interrupted deployment. Git-ignored. |
| `1337.lock` | Lock for an active deployment process. Git-ignored. |

`1337.json` contains:

- `schemaVersion`, `chainId`, `genesisHash`: schema and chain identity.
- `deployer`, `initialAdmin`: public account addresses.
- `contracts`: addresses keyed by `ParticipantRegistry` and `MedicalAccessController`.
- `deploymentTransactions`: deployment transaction hashes keyed by contract name.
- `artifactHashes`: compiled creation-bytecode hashes keyed by contract name.

Generate or verify the record with `npm run deploy:besu` from `smart-contract/`. Use `npm run deploy:besu -- --redeploy` for a fresh deployment. ABI arrays are exported separately under `smart-contract/abi/`.

See [Smart contracts](../../docs/smart-contracts.md) for configuration and recovery commands.
