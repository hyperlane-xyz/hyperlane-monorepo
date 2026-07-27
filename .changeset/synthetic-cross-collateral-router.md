---
'@hyperlane-xyz/core': minor
---

A synthetic (mint/burn) counterpart to `CrossCollateralRouter` was added as `CrossCollateralSynthetic`. It extends `HypERC20` so a synthetic leg that holds no collateral can participate in a metastable pool alongside collateral legs, supporting direct one-message atomic transfers both cross-chain (via the mailbox) and same-chain (direct `handle` call). Routing, enrollment, fee, and quote logic mirror `CrossCollateralRouter`; the only asset-type difference is burning on send and minting on receive, and the same-chain handoff dispatches through `IMessageRecipient` so collateral and synthetic legs interoperate in mixed pools.
