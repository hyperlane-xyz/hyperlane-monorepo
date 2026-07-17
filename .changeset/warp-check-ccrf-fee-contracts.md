---
"@hyperlane-xyz/sdk": patch
---

The warp check no longer diffs `CrossCollateralRoutingFee` `feeContracts`. These are the OffchainQuotedLinearFee standing-quote contracts wired dynamically per-recipient via submitQuote, so the static registry snapshot always drifted from on-chain state and emitted a perpetual violation every run.
