---
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

A fee submitter strategy was added to `warp apply` allowing a separate Safe or signer to submit fee-contract transactions. Same-chain Safe TX Builder payloads are now bundled into a single combined file per (chainId, safeAddress) pair. Transaction ordering was fixed so fee-recipient updates execute before ownership transfers. Router-owner `setFeeRecipient` calls were moved into the main submitter batch so a dedicated feeSubmitter only ever sees fee-contract-owner transactions. Safe TX Builder bundles from successful chains are now written before surfacing any partial-failure errors.
