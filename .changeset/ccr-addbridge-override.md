---
"@hyperlane-xyz/core": minor
---

`MovableCollateralRouter.addBridge` and `setRecipient` were made `external virtual`, and `CrossCollateralRouter` overrode them to also accept domains enrolled only via `_crossCollateralRouters` (mirroring the existing widening in `_setDestinationGas`). For CCR-only domains, `setRecipient` must be called to pin a target router since `_recipient`'s fallback cannot disambiguate among multiple CCR routers per domain. The overrides emit new `CCRRecipientSet` / `CCRBridgeAdded` events so CCR-only admin changes are observable off-chain.
