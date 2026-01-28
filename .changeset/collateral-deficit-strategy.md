---
'@hyperlane-xyz/rebalancer': minor
---

Added CollateralDeficitStrategy for just-in-time rebalancing. This strategy detected collateral deficits (negative effective balances from pending user transfers) and proposed fast rebalances using configured bridges. Modified reserveCollateral() to allow negative values for deficit detection.
