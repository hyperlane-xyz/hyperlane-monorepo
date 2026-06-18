---
'@hyperlane-xyz/sdk': patch
---

Core deployments finalized core ownership before deploying TestRecipient and retried post-transaction ISM and hook reads to tolerate RPC read-after-write lag.
