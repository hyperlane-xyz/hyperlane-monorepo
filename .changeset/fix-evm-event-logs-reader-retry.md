---
'@hyperlane-xyz/sdk': patch
---

Added retry with exponential backoff in EvmEventLogsReader before falling back to paginated RPC, and cached deployment block lookups to avoid redundant explorer/RPC calls.
