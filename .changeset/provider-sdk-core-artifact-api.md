---
'@hyperlane-xyz/provider-sdk': minor
---

Added `toDeployedOrUndefined` utility and `UnsetArtifactAddress` type to the artifact module. Extended `ProtocolProvider` interface with `createMailboxArtifactManager` and `createValidatorAnnounceArtifactManager` methods. Updated `mailboxArtifactToDerivedCoreConfig` to handle UNDERIVED artifacts with zero addresses gracefully. Widened `DerivedCoreConfig` fields to accept `UnsetArtifactAddress`.
