---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/utils': patch
---

`normalizeAddressEvm` now lowercases its input before checksumming, canonicalizing a bad-EIP-55-casing EVM address instead of returning it unchanged. `EvmIcaTxSubmitter.fromConfig` normalizes its origin-side EVM addresses (`owner`, origin `interchainAccountRouter`) up front, so bad casing no longer throws deep inside ethers mid-submission after irreversible deploys have run. Destination router and ISM (remote chain, not assumed EVM) are untouched.
