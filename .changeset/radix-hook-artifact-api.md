---
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/radix-sdk': minor
'@hyperlane-xyz/cosmos-sdk': minor
'@hyperlane-xyz/aleo-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

Migrated deploy-sdk to use Hook Artifact API, replacing AltVMHookReader and AltVMHookModule with unified reader/writer pattern. The migration adds deployment context support (mailbox address, nativeTokenDenom) for hook creation, following the same pattern as the ISM artifact migration. Key changes include new factory functions (createHookReader, createHookWriter), config conversion utilities (hookConfigToArtifact, shouldDeployNewHook), and removal of deprecated hook module classes.
