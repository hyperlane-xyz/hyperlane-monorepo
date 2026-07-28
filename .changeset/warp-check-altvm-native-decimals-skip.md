---
'@hyperlane-xyz/sdk': patch
---

The warp check no longer emits a spurious `decimals` ConfigMismatch for AltVM native tokens (e.g. Aleo `AleoHypNative`). The derived actual side has no decimals field for native tokens (`DerivedNativeWarpConfig` omits it), while the deploy-config-derived expected side carries decimals from the warp core config, so the field is now excluded from the diff on the expected side for AltVM native token types to keep both sides symmetric.
