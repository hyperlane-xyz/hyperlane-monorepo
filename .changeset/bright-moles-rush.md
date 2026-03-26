---
'@hyperlane-xyz/sdk': patch
---

EVM warp route reads now batch token-type probe calls through Multicall3 when available and start token fee derivation earlier so more of the same-chain work overlaps. Probe requests also recognize RPC bodies that wrap deterministic `ServerError(3)` reverts inside top-level `-32603` errors, so selector misses no longer fail warp reads on providers that use that error shape.
