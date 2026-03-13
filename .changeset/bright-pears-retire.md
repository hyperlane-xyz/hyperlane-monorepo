---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": patch
---

CrossCollateral contracts and tests were moved into the core Solidity package under `contracts/token` and `test/token`, and SDK imports were updated to use `@hyperlane-xyz/core` factories instead of `@hyperlane-xyz/multicollateral`.

