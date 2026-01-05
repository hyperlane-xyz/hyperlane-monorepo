---
'@hyperlane-xyz/rebalancer': minor
---

Added CollateralDeficitStrategy for just-in-time rebalancing. This strategy detects collateral deficits (negative effective balances from pending user transfers) and proposes fast rebalances using configured bridges. Modified reserveCollateral() to allow negative values for deficit detection.
