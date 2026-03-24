---
'@hyperlane-xyz/starknet-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/cli': minor
---

Added Starknet artifact API support across the TypeScript AltVM toolchain. The new `@hyperlane-xyz/starknet-sdk` package provides Starknet protocol, signer, provider, ISM, hook, mailbox, validator announce, and end-to-end test coverage. Deploy SDK protocol loading and the CLI context/signer flows were updated so Starknet chains can be resolved and used through the shared AltVM paths.
