---
'@hyperlane-xyz/sdk': major
---

Removed `websocketAuthorityEnabled` from relayer configuration and made `websocketUrl` enable canonical live websocket indexing, with RPC responsible for history recovery and fallback. For RPC-only indexing, omit `websocketUrl`.
