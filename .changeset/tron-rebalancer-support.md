---
'@hyperlane-xyz/rebalancer': minor
---

Added Tron blockchain support to the rebalancer using ProtocolType.Tron. Tron chains are treated as EVM-like for signer creation, block tag resolution, gas estimation, and transaction receipt parsing. LiFi bridge gracefully skips Tron chains (no Tron-compatible aggregator yet).
