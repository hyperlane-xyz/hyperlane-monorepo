---
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/cosmos-sdk': patch
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/radix-sdk': patch
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/starknet-sdk': patch
'@hyperlane-xyz/tron-sdk': patch
---

Protocol submitter configs, plus hook, warp, and fee artifact-manager contexts, were extended with every known address for their chain. Complete provider contexts now require the shared core deployment addresses, while artifact composition uses a separate partial-address context. Chain metadata remains the first factory argument.
