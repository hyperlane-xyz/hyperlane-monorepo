---
"@hyperlane-xyz/core": major
"@hyperlane-xyz/sdk": minor
---

The core Solidity package was extended with `AtomicLocalRebalancingBridge` for same-chain local rebalances.

`MovableCollateralRouter` stopped creating standing bridge token approvals. `addBridge` only allowlisted a bridge, `HypERC20Collateral` stopped approving bridges during bridge enrollment, and `rebalance` granted an exact temporary collateral-token approval based on the bridge quote. Expected bridges consumed that quoted allowance during `transferRemote`.

The `approveTokenForBridge(address,address)` helper was deprecated and cleared legacy standing approval instead of setting max approval. The selector was retained for upgrade and governance-tooling compatibility.

`AtomicLocalRebalancingBridge` required rebalancer calls to leave the required output token balance on the wrapper, transferred the required amount directly to the destination router, and refunded any unspent input or output token balance to the rebalancer after a successful local rebalance. Variable-output and exact-output swap paths no longer needed to include a destination-router transfer call or leave token dust in the wrapper.

The SDK stopped emitting bridge-approval transactions from `allowedRebalancingBridges[].approvedTokens`. The config field remained accepted for compatibility but was ignored.
