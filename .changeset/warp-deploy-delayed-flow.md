---
'@hyperlane-xyz/sdk': minor
---

Added end-to-end warp deploy support for the warp-route hybrid hook/ISMs:

- ISM trees containing `NET_FLOW_RATE_LIMITED` or `DELAYED_FLOW_ROUTER` nodes are now deferred to the post-token deploy pass like `RATE_LIMITED` ones (`TokenDeployer.setRateLimitedIsms` is renamed to `setDeferredIsms`; a deprecated `setRateLimitedIsms` delegate remains until the next major release): the token address is injected as `warpRouter` at deploy time, omitted `NET_FLOW_RATE_LIMITED` owners default to the chain's configured owner (mirroring `RATE_LIMITED`), and the single hybrid instance is wired as BOTH the token's ISM (inside its tree) and its hook.
- `enrollCrossChainRouters` gained a DelayedFlowRouterHookIsm pass: instances are deployed with the deployer as intermediate owner, paired cross-chain automatically (the `remoteIsms` pairing is derived from which chains' deploy configs contain a `DELAYED_FLOW_ROUTER` node — users never hand-write it), and ownership is transferred to the configured owner after the owner-gated enrollment.
- `warpRouter` became optional on the hybrid config schemas, mirroring `RATE_LIMITED`'s `recipient`: it is injected in warp-route context and asserted for standalone deploys via `HyperlaneIsmFactory`.
- `expandWarpDeployConfig` completes expected hybrid nodes with the deploy-managed values (`warpRouter`, `remoteIsms`) and defaults the expected `hook` to the hybrid node, so `warp check` converges cleanly on the same config that was deployed.
