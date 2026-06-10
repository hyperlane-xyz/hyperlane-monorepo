---
'@hyperlane-xyz/core': minor
---

CrossCollateralRouter now supports multiple allowed same-chain rebalance targets per domain via `addRebalanceTarget(uint32,bytes32)`, `removeRebalanceTarget(uint32,bytes32)`, `rebalanceTargets(uint32)`, and `isRebalanceTarget(uint32,bytes32)` (the new `IRebalanceTargets` interface). The enrolled remote router is always a valid target. `AtomicLocalRebalancingBridge` now exposes `rebalance(uint32 domain, uint256 collateralAmount, ITokenBridge sourceRouter, bytes32 destinationRecipient, bytes data)` mirroring the canonical rebalance signature with a catch-all `data` argument (the abi-encoded `CallLib.Call[]` for this bridge); `bytes32(0)` defaults to the source router's enrolled local router, otherwise the recipient must be an allowed rebalance target. `MovableCollateralRouter` is unchanged.
