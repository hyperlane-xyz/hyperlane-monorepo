---
'@hyperlane-xyz/sdk': major
'@hyperlane-xyz/relayer': major
---

Added SDK support for the new EVM warp-route flow-limiting ISM contracts:

- `DefaultIsm` was modeled as `IsmType.MAILBOX_DEFAULT`, deployed with its mailbox, derived through a contract-specific probe, and matched against that mailbox.
- `NetFlowRateLimitedHookIsm` and `DelayedFlowRouterHookIsm` were modeled as shared hook/ISM instances with typed config, deployment, derivation, matching, mutable ownership, and delayed-flow counterpart enrollment support. The hook side remains read-only so only the ISM deployment path creates the shared instance.
- Hybrid configs were required to sit in an exhaustive aggregation with a supported authenticating sibling. Core default-ISM configs and random mutable-ISM tests reject the warp-route-only hybrids.
- Hook and ISM readers use contract-specific probes so NULL-module hybrids are not mistaken for test ISMs and the net-flow hybrid is not mistaken for a plain rate-limited hook.
- Delayed-flow `maxDelay` values were bounded to a conservative operational maximum so adding the delay to the on-chain `uint48` timestamp cannot overflow in practical use.
- The relayer gained metadata building and decoding for all three types. `RoutingMetadata['type']` now includes `MAILBOX_DEFAULT`; because that exported union widening is breaking, the relayer package receives a major bump.
- `HookConfig` was expressed as an explicit union to avoid downstream TypeScript union-complexity failures.
