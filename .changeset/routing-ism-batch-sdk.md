---
'@hyperlane-xyz/sdk': minor
---

Wired `HyperlaneIsmFactory` to use the routing ISM `setIsms` and `removeIsms` functions added in `@hyperlane-xyz/core` 11.4.0. Enrollments and unenrollments were consolidated into chunked batched transactions sized by the per-chain `domainRoutingInitializationSize`, avoiding one tx per domain on low-capacity chains (citrea, shibarium, tempo, etc.). Version-gated via `PACKAGE_VERSION()` on the target routing ISM, with a per-domain fallback for older deployed ISMs.
