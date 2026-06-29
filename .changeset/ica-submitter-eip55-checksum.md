---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
---

`normalizeAddressEvm` now lowercases its input before checksumming, so a correctly-shaped EVM address with a bad EIP-55 mixed-case checksum is canonicalized instead of being returned unchanged. The EVM ICA transaction submitter (`EvmIcaTxSubmitter.fromConfig`) now normalizes its address props (`owner`, origin/destination `interchainAccountRouter`, `interchainSecurityModule`) up front. Previously a config value with valid hex shape but bad casing passed parsing and only failed later when ethers normalized it during ICA submission — after irreversible deploys had already run. Non-EVM and zeroish inputs are still returned unchanged.
