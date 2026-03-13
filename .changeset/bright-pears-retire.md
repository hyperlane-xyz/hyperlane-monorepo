---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/multicollateral": major
"@hyperlane-xyz/sdk": patch
---

CrossCollateral contracts and tests were moved into the core Solidity package under `contracts/token` and `test/token`, and SDK imports were updated to use `@hyperlane-xyz/core` factories instead of `@hyperlane-xyz/multicollateral`.

`@hyperlane-xyz/multicollateral` was converted to a compatibility package without local Solidity sources.
