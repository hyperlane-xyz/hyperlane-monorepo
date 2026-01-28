---
'@hyperlane-xyz/cli': patch
---

Fixed warp fee command failing for Cosmos chains with non-standard bech32 prefixes (e.g., osmo1, inj1) by generating placeholder addresses dynamically using the chain's bech32Prefix from metadata.
