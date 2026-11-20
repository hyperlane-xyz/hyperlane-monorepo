---
'@hyperlane-xyz/core': minor
---

A `HypNativeWethWrapper` adapter and CREATE2-based factory were added, letting WETH holders bridge through an existing `HypNative` route by pulling WETH, unwrapping, and forwarding. `ITokenBridge` was extended with a `token()` accessor (already present on all concrete implementations); `AbstractPredicateWrapper`'s `token` was retyped from `IERC20` to `address` and mocks were updated to expose `token()`.
