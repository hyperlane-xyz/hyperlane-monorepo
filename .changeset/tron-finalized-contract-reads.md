---
'@hyperlane-xyz/tron-sdk': patch
---

Routed explicit finalized contract reads through Tron solidified state and rejected malformed or failed VM results, allowing confirmed balance reads without unsupported historical JSON-RPC calls or unconfirmed fallbacks.
