---
"@hyperlane-xyz/provider-sdk": minor
"@hyperlane-xyz/deploy-sdk": minor
"@hyperlane-xyz/radix-sdk": minor
"@hyperlane-xyz/cosmos-sdk": minor
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/aleo-sdk": patch
---

Introduced the Artifact API for ISM operations on AltVMs. The new API provides a unified interface for reading and writing ISM configurations across different blockchain protocols. Radix ISM readers and writers fully implemented; Cosmos ISM readers implemented. The generic `IsmReader` in deploy-sdk replaces the legacy `AltVMIsmReader` and supports recursive expansion of routing ISM configurations.
