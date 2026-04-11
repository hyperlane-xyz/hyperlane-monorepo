---
'@hyperlane-xyz/sdk': patch
---

EVM warp route reads and token metadata derivation batched same-chain contract reads through Multicall3 when available, with fallback to individual calls when it is not. Warp fee readers also batched routing fee lookups so warp read/apply/deploy use fewer RPC round-trips on supported chains.
