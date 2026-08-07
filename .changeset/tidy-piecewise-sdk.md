---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/sealevel-sdk': patch
---

Piecewise-linear offchain-quoted fees were added to the shared fee model and
the EVM deployment, read, and update flows. Deployment now requires an initial
piecewise fallback while readers expose the current signer-managed fallback
without treating runtime changes as a redeployment. Sealevel now reports this
EVM-only fee type as unsupported.
