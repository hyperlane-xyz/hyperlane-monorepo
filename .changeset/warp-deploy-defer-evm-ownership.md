---
"@hyperlane-xyz/sdk": patch
---

Fixed a bug where deploying a warp route whose EVM owner differed from the deployer failed during cross-chain router enrollment with `Ownable: caller is not the owner`. The EVM token deployer transferred router ownership to the configured owner at the end of its per-protocol phase, before the global cross-chain enrollment (submitted by the deployer key) ran. `executeWarpDeploy` now deploys EVM routers under the deployer as an intermediate owner — mirroring the AltVM branch — so enrollment runs while the deployer still owns the router, and `enrollCrossChainRouters` hands ownership to the configured owner afterward. The deferred update also carries the configured ProxyAdmin owner through, so upgrade authority is transferred to the configured owner instead of being left with the deployer.
