---
'@hyperlane-xyz/sdk': minor
---

Added a GCP Cloud KMS signer config surface (`AgentSignerKeyType.Gcp`, `{ type: 'gcp', keyVersionName }`) to the agent config schema, alongside the existing AWS KMS signer, for validators and other agents that sign with a GCP-managed key.
