---
'@hyperlane-xyz/core': minor
---

Added `setBatch(DomainModule[])` and `removeBatch(uint32[])` to `DomainRoutingIsm` so routing ISM owners can enroll or unenroll many domains in a single transaction after initialization. Mirrors the `setHooks(HookConfig[])` pattern on `DomainRoutingHook`. Inherited by `IncrementalDomainRoutingIsm` (where `removeBatch` reverts, consistent with `remove`) and `DefaultFallbackRoutingIsm`.
