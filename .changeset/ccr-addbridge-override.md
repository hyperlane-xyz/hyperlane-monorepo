---
"@hyperlane-xyz/core": minor
---

`MovableCollateralRouter.addBridge` and `setRecipient` are now `external virtual`, and `CrossCollateralRouter` overrides them to also accept domains enrolled only via `_crossCollateralRouters` (mirroring the existing widening in `_setDestinationGas`). For CCR-only domains, `setRecipient` must be called to pin a target router since `_recipient`'s fallback cannot disambiguate among multiple CCR routers per domain.
