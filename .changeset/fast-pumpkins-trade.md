---
'@hyperlane-xyz/widgets': patch
---

Made `ChainSearchMenu` fit metadata-first consumers better by lazy-loading the chain-details drilldown, and hardened `ChainAddMenu` validation against duplicate `chainId` and effective `domainId` conflicts across merged base and override metadata.
