---
'@hyperlane-xyz/sdk': major
---

The agent config schema is updated as part of migrating validators from AWS to GCP:

- Added a GCP Cloud KMS signer config surface (`AgentSignerKeyType.Gcp`, `{ type: 'gcp', keyVersionName }`), alongside the existing AWS KMS signer, for validators and other agents that sign with a GCP-managed key.
- Renamed the GCS checkpoint syncer's `service_account_key` and `user_secrets` fields to `serviceAccountKey` and `userSecrets`, matching the camelCase convention used by the syncer's other fields, and added `useApplicationDefault` to support ambient GKE Workload Identity credentials. Hand-written agent configs using the old snake_case field names must be updated.
- Fixed the Ethereum/Tron protocol-signer refinement, which compared `signerType` against boolean expressions instead of the `AgentSignerKeyType` enum values and therefore never actually validated the AWS or Node signer types.
- Reduced the default multisig ISM validator sets for `bsctestnet`, `fuji`, and `sepolia` from 3 validators (threshold 2) to a single GCP-based validator (threshold 1), matching the new default validator agent config for these testnets during the migration rollout.
