---
"@hyperlane-xyz/sdk": patch
---

Restored zero-recipient safety after `bytesToProtocolAddress` was made format-only: added explicit `assert(!isZeroishAddress(recipient))` to `EvmNativeTokenAdapter.populateTransferTx`, `EvmTokenAdapter.populateApproveTx`, `EvmTokenAdapter.populateTransferTx`, and `CosmNativeHypCollateralAdapter.populateTransferRemoteTx`. `WarpCore.validateRecipient` already gates the user-facing path; the adapter-level guards cover direct callers (tests, scripts).
