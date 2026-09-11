---
'@hyperlane-xyz/sdk': minor
---

Added caller-provided fallback gas units for RPCs that reject EVM state overrides. Estimation now exposes and throws `StateOverrideUnsupportedError`, preserving JSON-RPC code `-32602`, when those RPCs have no fallback.
