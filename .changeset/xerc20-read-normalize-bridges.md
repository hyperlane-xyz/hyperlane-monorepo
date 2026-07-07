---
'@hyperlane-xyz/cli': patch
---

hyperlane xerc20 read now normalizes bridge addresses (via normalizeAddressEvm) before de-duplicating, so a bridge is no longer listed twice when on-chain and expected addresses differ only in EIP-55 casing (seen on Tron xERC20 routes).
