---
'@hyperlane-xyz/deploy-sdk': minor
---

Added `CoreWriter` and `CoreArtifactReader` for coordinating core deployments using the Artifact API pattern. The `CoreWriter` orchestrates mailbox, ISM, hook, and validator announce deployments with support for both create and update flows. Updated `AltVMCoreModule` to handle `UnsetArtifactAddress` in derived core configs.
