---
'@hyperlane-xyz/sdk': patch
---

The precision-rebalance warning in `getLocalStorageGasOracleConfig` now names the local -> remote chain pair it applies to, so it is possible to tell which gas oracle config underflowed without correlating raw gas price / exchange rate values.
