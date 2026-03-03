---
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/cosmos-sdk': patch
---

Deprecated AltVM warp module classes were removed from deploy-sdk and replaced with the artifact API.

deploy-sdk removed public exports:
- AltVMWarpModule (use createWarpTokenWriter instead)
- AltVMWarpRouteReader (use createWarpTokenReader instead)
- AltVMDeployer (use createWarpTokenWriter per-chain instead)
- warpModuleProvider (no longer needed)
- ismConfigToArtifact (moved to @hyperlane-xyz/provider-sdk/ism)
- shouldDeployNewIsm (moved to @hyperlane-xyz/provider-sdk/ism)

provider-sdk breaking change: warpConfigToArtifact no longer accepts pre-built ismArtifact/hookArtifact parameters; ISM and hook conversion is now handled internally from the config.

cosmos-sdk: name and symbol for warp tokens without on-chain metadata were changed from empty strings to 'Unknown'.

CLI and SDK were updated to use the new artifact API via createWarpTokenWriter and createWarpTokenReader.
