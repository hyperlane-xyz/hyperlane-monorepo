---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/rebalancer': patch
---

Added a polling balance reader that reused token adapters for up to 15 minutes and combined concurrent same-chain EVM balance reads through Multicall3. Rebalancer routes with one token per chain retained separate balance calls but saved repeated collateral metadata reads. Failed Multicall probes and aggregate calls retried individual token reads, preserving confirmed block tags and per-read errors.
