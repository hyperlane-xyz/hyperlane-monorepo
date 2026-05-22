---
"@hyperlane-xyz/utils": patch
"@hyperlane-xyz/sdk": patch
---

A `syntheticCcrSwapMessageId` helper was added to `@hyperlane-xyz/utils` for deterministically computing the synthetic message ID of a same-chain CCR swap given its transaction hash and log index. The scraper agent config schema in `@hyperlane-xyz/sdk` was extended with an optional `ccrRouters` field mapping domain IDs to their CCR router-to-collateral address pairs.
