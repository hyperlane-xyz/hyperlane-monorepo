---
"@hyperlane-xyz/core": major
---

Refactor warp route contracts for shallower inheritance tree and smaller bytecode size.

Deprecated `Router` and `GasRouter` internal functions have been removed.

`FungibleTokenRouter` has been removed and functionality lifted into `TokenRouter`.

`quoteTransferRemote` and `transferRemote` can no longer be overriden with optional `hook` and `hookMetadata` for simplicity.

`quoteTransferRemote` returns a consistent shape of `[nativeMailboxDispatchFee, internalTokenFee, externalTokenFee]`.

`HypNative` and `HypERC20Collateral` inherit from `MovableCollateral` and `LpCollateral` but other extensions (eg `HypXERC20`) do not. Storage layouts have been preserved to ensure upgrade compatibility.
