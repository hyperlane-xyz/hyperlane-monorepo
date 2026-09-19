---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/rebalancer': patch
---

Added a polling balance reader that reused token adapters for up to 15 minutes and combined concurrent standard EVM balance reads through Multicall3. Updated rebalancer monitoring to reduce RPC usage while retaining fresh balances, confirmed block tags, and per-read errors.
