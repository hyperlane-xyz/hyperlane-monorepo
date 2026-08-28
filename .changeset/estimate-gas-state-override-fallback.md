---
'@hyperlane-xyz/sdk': minor
---

Added balance-independent EVM fee estimation with caller-provided fallback gas units for RPCs that reject state overrides. Estimation now fails with `StateOverrideUnsupportedError` when those RPCs have no fallback.
