---
'@hyperlane-xyz/starknet-sdk': patch
'@hyperlane-xyz/deploy-sdk': patch
'@hyperlane-xyz/provider-sdk': patch
'@hyperlane-xyz/cli': patch
---

Starknet AltVM follow-up behavior was fixed across the CLI toolchain. Warp apply/update paths now preserve existing Starknet hook and ISM settings when config leaves them unset or uses empty addresses, zero-address hook and ISM references are normalized as unset during provider artifact conversion, and core mailbox bootstrap only passes through existing hook addresses for Starknet while other AltVMs keep zero-address placeholders.
