---
"@hyperlane-xyz/deploy-sdk": major
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/sdk": patch
---

Integrated warp artifact API to replace module abstraction. WarpTokenReader and WarpTokenWriter provide unified interface for reading and deploying warp tokens across all protocols. The artifact API implementation follows ISM and Hook patterns for consistency.

**Breaking changes in @hyperlane-xyz/deploy-sdk:**
- Removed `AltVMWarpModule` - use `createWarpTokenWriter()` instead
- Removed `AltVMWarpRouteReader` - use `createWarpTokenReader()` instead
- Removed `AltVMDeployer` - use `WarpTokenWriter.create()` instead
- Removed `warpModuleProvider` - no replacement needed

**New exports in @hyperlane-xyz/deploy-sdk:**
- `createWarpTokenReader(chainMetadata, chainLookup)` - creates warp token reader
- `WarpTokenWriter` class with `create()` and `update()` methods
- `createWarpTokenWriter(chainMetadata, chainLookup, signer)` - creates warp token writer

**Migration guide:**
```typescript
// Before
const warpModule = new AltVMWarpModule(chainLookup, signer, args);
const config = await warpModule.read();
const txs = await warpModule.update(expectedConfig);

// After
const reader = createWarpTokenReader(chainMetadata, chainLookup);
const writer = createWarpTokenWriter(chainMetadata, chainLookup, signer);
const config = await reader.deriveWarpConfig(address);
const artifact = warpConfigToArtifact(expectedConfig, chainLookup);
const deployedArtifact = {
  artifactState: ArtifactState.DEPLOYED,
  config: artifact.config,
  deployed: { address },
};
const txs = await writer.update(deployedArtifact);
```
