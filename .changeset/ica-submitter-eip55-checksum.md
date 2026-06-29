---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
---

`normalizeAddressEvm` now lowercases its input before checksumming, so a correctly-shaped EVM address with a bad EIP-55 mixed-case checksum is canonicalized instead of being returned unchanged. The EVM ICA transaction submitter (`EvmIcaTxSubmitter.fromConfig`) now normalizes its origin-side address props (`owner`, origin `interchainAccountRouter`) up front. Previously a config value with valid hex shape but bad casing passed parsing and only failed later when ethers normalized it during ICA submission — after irreversible deploys had already run. The destination router and ISM live on the remote chain (which is not assumed to be EVM) and are passed through untouched. Non-EVM and zeroish inputs are still returned unchanged.
