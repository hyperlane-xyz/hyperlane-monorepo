---
'@hyperlane-xyz/sdk': patch
---

Restored EVM fee estimates on RPCs that reject balance state overrides. Callers can provide fallback gas units to keep estimation balance-independent; otherwise the SDK retries against the sender's real balance.
