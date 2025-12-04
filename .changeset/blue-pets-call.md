---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/cosmos-sdk": minor
"@hyperlane-xyz/radix-sdk": minor
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

- Update CLI context `altVmSigners` to be a `ChainMap` instead of `AltVMSignerFactory`, 
- Update CLI context `altVmProviders` to be a `ChainMap` instead of `AltVMSignerFactory`.
- Update all existing getter methods to use `mustTry`, instead of `assert`.
- Delete `AltVMSupportedProtocols` and `AltVMProviderFactory`.
- Move functions from `AltVMSignerFactory` to top-level functions.
- Add `getMinGas` to Aleo, Cosmos and Radix ProtocolProvider.
