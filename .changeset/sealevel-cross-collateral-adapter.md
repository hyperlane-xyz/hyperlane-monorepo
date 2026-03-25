---
'@hyperlane-xyz/sdk': minor
---

Added `SealevelHypCrossCollateralAdapter` for Sealevel cross-collateral warp token transfers. The adapter supports both same-chain (local CPI) and cross-chain (mailbox dispatch) paths, with account discovery via `HandleLocalAccountMetas` simulation. WarpCore CC transfer flow was made protocol-agnostic by replacing EVM-specific casts with an `isHypCrossCollateralAdapter` type guard. Added `SealevelHypCrossCollateral` token standard and wired it into the Token factory.
