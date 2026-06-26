---
'@hyperlane-xyz/sdk': patch
---

ICA transaction submitter address props (`owner`, `originInterchainAccountRouter`, `destinationInterchainAccountRouter`, `interchainSecurityModule`) were validated for EIP-55 checksum at parse time via a new `ZEvmAddress` schema. Previously these used the hex-shape-only `ZHash` regex, so a mixed-case address with a bad checksum passed config parsing and only failed later when ethers normalized it during ICA submission — after irreversible deploys had already run. Validation now fails fast at the config boundary with a clear message.
