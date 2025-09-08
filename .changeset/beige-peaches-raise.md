---
"@hyperlane-xyz/sdk": minor
---

Update type to enforce consistency between fee token addresses and warp route token addresses through schema validation. The main change adds validation logic to ensure tokenFee.token matches config.token for collateral token configurations.
