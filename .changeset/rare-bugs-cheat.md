---
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/sdk': patch
---

BREAKING: Removed deprecated warp module classes from deploy-sdk.

Removed public exports:
- AltVMWarpModule (use createWarpTokenWriter instead)
- AltVMWarpRouteReader (use createWarpTokenReader instead)
- AltVMDeployer (use createWarpTokenWriter per-chain instead)
- warpModuleProvider (no longer needed)
- ismConfigToArtifact (moved to @hyperlane-xyz/provider-sdk/ism)
- shouldDeployNewIsm (moved to @hyperlane-xyz/provider-sdk/ism)

CLI and SDK updated to use new artifact API.
