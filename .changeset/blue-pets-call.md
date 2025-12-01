---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/cosmos-sdk": minor
"@hyperlane-xyz/radix-sdk": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

- Update `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`, 
- Update `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
- Update all existing getter methods to use `mustTry`, instead of `assert`.
- Update SignerFactory calls to use new Provider API.
- Add `getMinGas` to Cosmos and Radix ProtocolProvider.
