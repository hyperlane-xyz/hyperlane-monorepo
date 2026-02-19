---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/starknet-sdk': minor
---

Starknet artifact API support was implemented end-to-end across provider-sdk, deploy-sdk, and CLI flows. A first-class `@hyperlane-xyz/starknet-sdk` protocol provider was added with mailbox, ISM, hook, and validator announce artifact managers and Starknet provider/signer clients.

Provider hook/core artifact types were extended with `protocolFee` support, including deployment/update/read conversion paths and core address serialization. Cosmos Native, Radix, and Aleo hook artifact managers now explicitly reject unsupported protocol fee hooks.

Deploy SDK now registers Starknet protocol providers and supports Starknet hook handling in AltVM warp read/update flows. CLI AltVM signer creation now supports Starknet by reading account addresses from strategy `submitter.userAddress` (or `HYP_ACCOUNT_ADDRESS_STARKNET` fallback) and passing them to protocol signers.

Starknet token standard resolution in SDK warp output paths was fixed by wiring Starknet token types into `tokenTypeToStandard`.
