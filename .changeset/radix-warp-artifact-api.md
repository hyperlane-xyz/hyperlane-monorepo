---
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/radix-sdk': minor
---

Implemented warp token artifact API for Radix. Added warp token artifact types to provider-sdk including `WarpArtifactConfig`, `RawWarpArtifactConfig`, and conversion functions between Config API and Artifact API formats. The artifact types support collateral and synthetic warp tokens with proper handling of nested ISM artifacts and domain ID conversions. Implemented Radix warp token readers and writers for both collateral and synthetic tokens, with artifact manager providing factory methods for type-specific operations. Writers support creating new warp tokens with ISM configuration, enrolling remote routers, and transferring ownership. Update operations generate transaction arrays for ISM changes, router enrollment/unenrollment, and ownership transfers. Native token type is not supported on Radix.
