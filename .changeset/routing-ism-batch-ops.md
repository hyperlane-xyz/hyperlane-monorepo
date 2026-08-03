---
'@hyperlane-xyz/core': minor
---

Added `setIsms(IsmConfig[])` and `removeIsms(uint32[])` to `DomainRoutingIsm` so routing ISM owners could enroll or unenroll many domains in a single transaction after initialization. Emitted `ModuleSet` and `ModuleRemoved` when domain ISM mappings changed. Mirrored the `setHooks(HookConfig[])` pattern on `DomainRoutingHook`. Was inherited by `IncrementalDomainRoutingIsm` (where `removeIsms` reverted, consistent with `remove`) and `DefaultFallbackRoutingIsm`.
