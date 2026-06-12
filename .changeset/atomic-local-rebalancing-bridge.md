---
"@hyperlane-xyz/core": major
"@hyperlane-xyz/sdk": minor
---

The core Solidity package adds `AtomicLocalRebalancingBridge` for same-chain local rebalances. The bridge binds its source router at construction so the caller cannot supply an arbitrary router, guards the entire local-rebalance flow (including the user-supplied calls) against reentrancy, funds the destination router only from output produced by those calls, and refunds the input, output, or native balance accrued during the call to the rebalancer while leaving any pre-existing donations untouched.

`MovableCollateralRouter` no longer creates standing bridge token approvals. `addBridge` only allowlists a bridge, `HypERC20Collateral` no longer approves bridges during bridge enrollment, and `rebalance` grants an exact temporary collateral-token approval based on the bridge quote and revokes any unconsumed allowance after `transferRemote`.

The `approveTokenForBridge(address,address)` helper is deprecated and clears legacy standing approval instead of setting max approval. The selector is retained for upgrade and governance-tooling compatibility.

The SDK no longer emits bridge-approval transactions from `allowedRebalancingBridges[].approvedTokens`. The config field is still accepted for compatibility but is ignored.
