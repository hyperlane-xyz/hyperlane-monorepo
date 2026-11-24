---
"@hyperlane-xyz/sdk": patch
---

RoutingFee warp-apply updates now clear destinations removed from the target config instead of leaving them wired. The plain RoutingFee branch of `EvmTokenFeeModule.update` prunes orphan sub-fee entries and emits `setFeeContract(domain, 0)` for on-chain destinations absent from the target, mirroring the existing CrossCollateralRoutingFee removal logic. `EvmTokenFeeReader` now enumerates the RoutingFee contract's own `domains()` set so every configured destination is discovered independently of router enrollment, which also keeps existing sub-fee pointers from being needlessly redeployed when a destination is omitted from the caller's read hints. Removal and pointer transactions now carry the chain's EVM chain ID rather than its Hyperlane domain ID so the JSON-RPC submitter accepts them on chains where the two differ.
