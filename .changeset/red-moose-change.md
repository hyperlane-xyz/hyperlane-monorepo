---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": patch
---

Implement token fees on FungibleTokenRouter

Removes `metadata` from return type of internal `TokenRouter._transferFromSender` hook

To append `metadata` to `TokenMessage`, override the `TokenRouter._beforeDispatch` hook
