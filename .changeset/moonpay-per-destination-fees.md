---
'@hyperlane-xyz/infra': patch
---

The CROSS/moonpay USDC and USDT warp route fee configs were given per-destination-token granularity by emitting a CrossCollateralRoutingFee leaf for each enrolled destination router (alongside the existing default-router fallback), allowing distinct fees per destination token.
