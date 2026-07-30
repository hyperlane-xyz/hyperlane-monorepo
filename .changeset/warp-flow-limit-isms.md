---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/relayer': patch
---

Added SDK support for the new EVM warp-route flow-limiting ISM contracts:

- `DefaultIsm` is modeled as `IsmType.MAILBOX_DEFAULT` (`defaultIsm`): a zero-config, ownerless routing ISM that defers to the mailbox's default ISM. It is deployable via `HyperlaneIsmFactory` (the mailbox comes from the deploy context), derived by `EvmIsmReader` through a `mailbox()` probe that keeps the legacy `InterchainAccountIsm` fallback intact, and matched by `moduleMatchesConfig` against the expected mailbox.
- `NetFlowRateLimitedHookIsm` and `DelayedFlowRouterHookIsm` are modeled as hybrid hook/ISM contracts with the ISM config as the canonical deploy surface (`IsmType.NET_FLOW_RATE_LIMITED` / `IsmType.DELAYED_FLOW_ROUTER`). The immutable rate parameters (`warpRouter`, `thresholdBps`, `maxDelay`, `duration`) force a redeploy when changed, while `owner` — and, for the delayed flow router, `remoteIsms` enrollment (the remote DelayedFlowRouterHookIsm counterparts) — is updated in place by `EvmIsmModule`. Ownership transfer is ordered after the owner-gated enrollment calls.
- `EvmIsmReader` derives both hybrids from their NULL module type via contract-specific probes (`warpRouter()`, then `maxDelay()`), so they are no longer misderived as `testIsm`.
- The hook side gained read-only views (`HookType.NET_FLOW_RATE_LIMITED` / `HookType.DELAYED_FLOW_ROUTER`) with probes in `EvmHookReader`, so the hybrids are no longer silently misderived as plain `rateLimitedHook` / `domainRoutingHook`. `EvmHookReader` preserves them as address references when nested inside other hooks, and `EvmHookModule` rejects deploying them from the hook side.
- The relayer builds null metadata for both hybrids and resolves `IsmType.MAILBOX_DEFAULT` through the dynamic routing metadata builder via the on-chain `route(message)` call.
- The `HookConfig` type is now a pre-computed explicit union annotated onto `HookConfigSchema` (mirroring the existing `IsmConfig` mitigation) to avoid TS2590 union-complexity errors in downstream packages.
