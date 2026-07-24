---
"@hyperlane-xyz/core": minor
---

`AtomicLocalRebalancingBridge` runs the rebalancer-supplied calls with these constraints:

- They execute through the new `CallLib.safeMulticall`, which rejects delegatecalls, so a call cannot run in the bridge's storage context or re-arm its transient callback slot to pull the source router more than once.
- If the source exposes an ERC4626-style `totalAssets()` (probed via the new duck-typed `SafeTotalAssets` library, so non-vault sources are unaffected), it must be unchanged across the calls, preventing a source-collateral drain masked by depositing into the source's LP vault for redeemable shares.

`rebalance` also documents that the calls run with the bridge's authority and can grant a standing token allowance over any balance it holds, so `recoverToken` does not protect those holdings; and `MovableCollateralRouter`'s `CollateralMoved` event documents that its `recipient`/`amount` do not describe an atomic-bridge-driven move (consumers should read the bridge's `LocalRebalanceExecuted` event).
