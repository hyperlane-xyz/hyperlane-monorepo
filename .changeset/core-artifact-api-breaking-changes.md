---
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/cli': patch
---

Removed `AltVMCoreModule`, `AltVMCoreReader`, and `coreModuleProvider` from deploy-sdk in favor of the new core artifact API (`CoreWriter`, `createCoreReader`). Added `coreConfigToArtifact` and `coreResultToDeployedAddresses` helpers to provider-sdk. Updated CLI core deploy and read commands to use the new API.
