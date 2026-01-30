---
'@hyperlane-xyz/infra': patch
---

The check-warp-deploy script now filters out deprecated chains when creating the MultiProvider to avoid attempting to fetch RPC secrets for chains that are no longer supported.
