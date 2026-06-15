---
"@hyperlane-xyz/core": major
"@hyperlane-xyz/sdk": minor
---

The core Solidity package adds `AtomicLocalRebalancingBridge` for same-chain local rebalances. The bridge binds its source router at construction so the caller cannot supply an arbitrary router, guards the entire local-rebalance flow (including the user-supplied calls) against reentrancy, funds the destination router only from output produced by those calls, and refunds the input, output, or native balance accrued during the call to the rebalancer while leaving any pre-existing donations untouched. Its entry point `rebalance(uint32,uint256,ITokenBridge,bytes32,bytes)` mirrors the canonical rebalance signature: the source argument is a checked echo of the bound router, the destination recipient is supplied per call and validated against the source's rebalance targets, and the trailing bytes carry the ABI-encoded calls.

`CrossCollateralRouter` implements the new `IRebalanceTargets` interface, allowing multiple local rebalance recipients per domain beyond the enrolled remote router. Owners manage the additional targets with `addRebalanceTarget`/`removeRebalanceTarget`, and `isRebalanceTarget` authorizes a recipient. The source of an `AtomicLocalRebalancingBridge` must be a `CrossCollateralRouter`, asserted at construction.

`MovableCollateralRouter` no longer creates standing bridge token approvals. `addBridge` only allowlists a bridge, `HypERC20Collateral` no longer approves bridges during bridge enrollment, and `rebalance` grants an exact temporary collateral-token approval based on the bridge quote and revokes any unconsumed allowance after `transferRemote`.

The `approveTokenForBridge(address,address)` helper is deprecated and clears legacy standing approval instead of setting max approval. The selector is retained for upgrade and governance-tooling compatibility.

The SDK no longer emits bridge-approval transactions from `allowedRebalancingBridges[].approvedTokens`. The config field is still accepted for compatibility but is ignored. During `warp apply`, the SDK revokes legacy standing rebalancing-bridge allowances when a route is upgraded in place from a pre-revoke contract version, so an upgraded route does not retain the old max approval.
