---
'@hyperlane-xyz/sdk': patch
---

Core deployments finalized core ownership before deploying TestRecipient, retried post-transaction ISM and hook reads to tolerate RPC read-after-write lag, and preserved nested RPC error messages when CALL_EXCEPTION wraps provider failures.
