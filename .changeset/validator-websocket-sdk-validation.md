---
'@hyperlane-xyz/sdk': patch
---

Aligned validator WebSocket configuration validation with the Rust agent: URLs must use `/validators` without query parameters. Updated the schema description to reflect RPC-verified live-start handoff and checkpoint verification, so invalid configurations are rejected before startup.
