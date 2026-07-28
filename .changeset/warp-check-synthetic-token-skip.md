---
'@hyperlane-xyz/sdk': patch
---

The warp check no longer emits a spurious `token` ConfigMismatch for synthetic tokens. The SVM/cosmos synthetic reader populates `token` with the on-chain mint/denom (a deterministic deployment artifact derived from the router), while the deploy-config-derived expected side has no counterpart, so the field is now excluded from the diff on both sides for synthetic token types.
