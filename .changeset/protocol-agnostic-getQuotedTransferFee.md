---
"@hyperlane-xyz/sdk": major
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/fee-quoting": patch
---

- `QuotedTransferProvider` gained a `getQuotedTransferFee` method so display and submit call sites use the same protocol-agnostic entry point for offchain-quoted transfers.
- `SealevelQuotedTransferProvider.getQuotedTransferFee` decodes the warp signed-quote `data` as a Borsh `FeeDataStrategy` (17 bytes, Linear-only) and applies the on-chain Linear formula at the transfer amount; the IGP signed-quote `data` decodes as a 33-byte `IgpQuoteData` (`token_exchange_rate ‖ gas_price ‖ token_decimals`) and the result is computed via `compute_gas_fee` against `tokenData.destination_gas` plus the per-destination `OverheadIgp.gas_overhead` (matching the on-chain `OverheadIgp::quote_gas_payment`).
- `SealevelHypTokenAdapter.innerIgpFeeState` now exposes the resolved `gasOverheads` map alongside the inner-IGP account.
- `WarpCore.getQuotedTransferFee` now takes `quotedTransfer: QuotedTransferProvider` — callers construct the provider themselves, mirroring `getTransferRemoteTxs({ quotedTransfer })`.
- The EVM provider is refactored around a shared private `runQuoteExecute` helper and the dead `QuotedCallsParams.feeQuotes` reuse field is removed; both display and submit now invoke the `quoteExecute` eth_call independently (deterministic for a given `(quotes, clientSalt, block)`, so display ↔ submit results match within a block).
- The `hyperlane warp send` CLI now unifies the preflight estimate behind `WarpCore.getQuotedTransferFee` for both EVM and Sealevel origins, logging the quoted IGP + token fee before submit.
- The SVM fee-quoting service's CC quote-walker docstring is corrected to reflect that the on-chain CC submit handler enforces route scope via `CcQuoteFeeValidation::{Specific, Default}`; the `DEFAULT_ROUTER` transient-fallback behavior it describes already ships on `main`, and this change adds test coverage for it.
- The Sealevel IGP fee computation normalizes the Borsh-decoded `destination_gas` and `gasOverheads` values (bn.js `BN` at runtime despite their `bigint` types) before arithmetic, so a `warp send` preflight on a fee-enabled SVM origin no longer crashes on the `BN`-vs-`bigint` type mismatch.
- Legacy (non-upgraded) SVM IGP routes with no offchain `fee_config` now display the on-chain `quoteGasPayment` fee via the shared `SealevelHypTokenAdapter.quoteLegacyIgpGasPayment` helper instead of reporting IGP = 0, matching what the submit path pays.
- `SealevelQuotedTransferProvider.getQuotedTransferFee` now skips IGP for same-domain (local) transfers — mirroring the submit path's local gate — so a local cross-collateral transfer no longer asserts on an unset `destination_gas`.
- The SVM IGP fee computation now rejects a quote whose priced fee exceeds `u64`, mirroring the on-chain `as_u64()` narrowing, so preflight fails fast instead of displaying a fee the transfer could never pay.
- Tests added for warp Linear strategy decode + IGP gas-fee math (12 new cases) and a CC DEFAULT_ROUTER cascade case in the SVM transfer-remote E2E.
