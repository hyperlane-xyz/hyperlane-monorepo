---
'@hyperlane-xyz/sdk': patch
---

The SDK core and IGP deployers were updated to support recover-only legacy IGP configurations and opt out of QuotedCalls deployments. An `igpVersion` switch (`legacy`/`latest`) was added to the IGP hook config and a `deployQuotedCalls` switch to the core config; legacy IGP deploy paths are kept recover-only by requiring cached `proxyAdmin`, `storageGasOracle`, and `interchainGasPaymaster` addresses. `CoreConfigSchema` now rejects configs that pair a legacy IGP (`igpVersion: legacy`) with `deployQuotedCalls` left enabled, since QuotedCalls and the offchain-quoting IGP both require EIP-1153 transient storage and must ship together on the same chains.

Legacy IGP configs that include `quoteSigners` now fail fast instead of silently skipping signer updates, because legacy IGP contracts do not expose the offchain-quoting signer interface.
