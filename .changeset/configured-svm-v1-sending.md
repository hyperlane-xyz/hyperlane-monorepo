---
"@hyperlane-xyz/sealevel-sdk": patch
"@hyperlane-xyz/provider-sdk": patch
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/widgets": patch
"@hyperlane-xyz/rebalancer": patch
---

Added opt-in Sealevel v1 sending and configurable receipt reads per chain. V1 transactions moved compute limits and priority fees into the header and enforced version-specific size limits, while other SVMs retained v0 defaults.
