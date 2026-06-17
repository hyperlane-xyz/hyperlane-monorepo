---
'@hyperlane-xyz/sdk': patch
---

The gas oracle exchange-rate computation in `getLocalStorageGasOracleConfig` was generalized to handle low-decimal fee tokens. When the fee token has fewer decimals than the remote native token (e.g. a 6-decimal ERC20 fee token paying for an 18-decimal native chain), the scaled exchange rate could fall below 1 and floor to a coarse integer, badly mispricing the quote. The existing precision-loss adjustment now also rebalances in this direction, shifting magnitude from the gas price into the exchange rate (their product, and thus the quote, is preserved) so the on-chain exchange rate keeps its precision. Same-decimal native pairs are unaffected.
