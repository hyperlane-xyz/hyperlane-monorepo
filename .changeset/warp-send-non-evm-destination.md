---
"@hyperlane-xyz/cli": patch
---

Added support for `hyperlane warp send` from EVM chains to non-EVM destinations (Eclipse, Solana, Cosmos). Transaction is submitted on EVM origin, Rust relayer handles delivery. Non-EVM destinations require explicit `--recipient`.
