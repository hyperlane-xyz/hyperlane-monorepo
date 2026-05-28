---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": minor
---

The core Solidity package was extended with `AtomicLocalRebalancingBridge` for same-chain local rebalances.

`MovableCollateralRouter` stopped creating standing bridge token approvals. `addBridge` now only allowlists a bridge, `HypERC20Collateral` no longer approves bridges during bridge enrollment, and `rebalance` grants an exact temporary collateral-token approval based on the bridge quote. Expected bridges consume that quoted allowance during `transferRemote`.

The `approveTokenForBridge(address,address)` helper was deprecated and now clears legacy standing approval instead of setting max approval. The selector is retained for upgrade and governance-tooling compatibility.

The SDK no longer emits bridge-approval transactions from `allowedRebalancingBridges[].approvedTokens`. The config field remains accepted for compatibility but is ignored.
