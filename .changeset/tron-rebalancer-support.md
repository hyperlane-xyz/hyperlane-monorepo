---
'@hyperlane-xyz/rebalancer': minor
---

Added Tron blockchain support to the rebalancer using ProtocolType.Tron. Tron chains were treated as EVM-like for signer creation, block tag resolution, gas estimation, and transaction receipt parsing. The LiFi bridge was updated to gracefully skip Tron chains as no Tron-compatible aggregator is available.
