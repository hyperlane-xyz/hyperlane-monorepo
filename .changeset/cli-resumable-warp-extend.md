---
'@hyperlane-xyz/cli': minor
---

Warp route extension deployments are now performed per-chain in parallel. Successful deployments are written to the registry before reporting failures, making `warp apply` resumable — re-running after a partial failure skips already-deployed chains.
