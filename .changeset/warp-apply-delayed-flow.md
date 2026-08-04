---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

Extended DelayedFlowRouterHookIsm auto-enrollment from `warp deploy` to `warp apply`:

- `EvmWarpModule` now recognises the hybrid hook/ISMs when they appear as the expected hook: instead of routing them through the hook deployment path (which rejects them by design), the instance is resolved from the ISM tree being installed and wired with a single `setHook`, emitting nothing once it is already the router's hook. The ISM step also injects the paired `warpRouter` into hybrid nodes, mirroring the existing `RATE_LIMITED` recipient injection, so warp-route configs can continue to omit it.
- `WarpUpdateResult` gained an optional `deployedIsm` field carrying the ISM tree the returned transactions install, which callers need when the tree is deployed while those transactions are still being built.
- Combining a hybrid hook/ISM with a `predicateWrapper` on the same chain is now rejected with an explicit error instead of silently dropping one of them, since both must own the router's hook slot.
- The cross-chain enrollment logic used by `warp deploy` was extracted into the exported `deriveDelayedFlowEnrollmentTargets` and `buildDelayedFlowEnrollmentTxs` helpers, and `warp apply` now runs the same pass after its per-chain updates. Adding a hybrid to an existing route, extending a route to a new chain, and reconciling enrollment drift all produce the enrollment transactions automatically, routed to whichever submitter owns each instance.
