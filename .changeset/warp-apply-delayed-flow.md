---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
---

Extended DelayedFlowRouterHookIsm auto-enrollment from `warp deploy` to `warp apply`:

- `warp apply` now resolves one shared hybrid leaf from the paired hook and ISM trees, enrolls delayed-flow counterparts, and uses the same ordinary per-chain submitter path as other non-fee warp updates.
- Each chain receives one ordered batch: upgrades, delayed-flow enrollment, hook installation, ISM installation, then router updates. Removal reverses the shared-instance operations so the ISM is removed before the hook. Operators must quiesce and drain the route because batches cannot execute atomically across chains.
- Adding, replacing, removing, extending, and resuming interrupted hybrid updates were covered. Safe, ICA, timelock, file, and distinct fee submitters keep their existing behavior.
- Preflight validation rejects partial delayed-flow routes, foreign legs, nonce-zero mailboxes, conflicting hybrid declarations, predicate wrappers, unsupported token types, zero peers, and delayed-flow routes with a non-zero ERC20 fee hook before deploying contracts.
- Route-derived peers override stale read-derived in-route `remoteIsms`; configured external peers are retained. Unknown on-chain domains are surfaced by `warp check` and removed by `warp apply`.
- Route-scoped CLI relaying was extended to discover installed delayed-flow instances from each EVM router's active hook tree, so `--warp-route-id` admits both token transfers and DFR preverification messages.
- EVM update planning is no longer automatically retried because planning can deploy contracts before later reads fail. AltVM planning retains its existing retry behavior.
