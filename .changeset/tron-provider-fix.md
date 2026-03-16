---
'@hyperlane-xyz/tron-sdk': patch
---

Removed automatic `/jsonrpc` suffix appending in TronJsonRpcProvider. Third-party RPC providers (Alchemy, Ankr, Dwellir) serve JSON-RPC at their root URL and the suffix caused 404s. Callers should provide the correct URL directly.
