---
'@hyperlane-xyz/aleo-sdk': minor
'@hyperlane-xyz/utils': patch
---

Implemented warp token artifact API for Aleo. Added warp token readers and writers for native, collateral, and synthetic tokens, with AleoWarpArtifactManager providing factory methods for type-specific operations. Writers support creating new warp tokens with ISM and Hook configuration, enrolling remote routers, and transferring ownership. Update operations generate transaction arrays for ISM and Hook changes, router enrollment/unenrollment, and ownership transfers.
