---
"@hyperlane-xyz/sdk": patch
---

RoutingFee warp-apply updates now clear destinations removed from the target config instead of leaving them wired. The plain RoutingFee branch of `EvmTokenFeeModule.update` prunes orphan sub-fee entries and emits `setFeeContract(domain, 0)` for on-chain destinations absent from the target, mirroring the existing CrossCollateralRoutingFee removal logic. `EvmWarpModule` forwards the on-chain enrolled destinations as `routingDestinations` hints so the reader observes those orphan entries during apply.
