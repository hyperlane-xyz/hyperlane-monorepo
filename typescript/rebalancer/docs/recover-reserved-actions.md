# Recovering reserved rebalancer actions

Action state and origin allowance locks are in memory. Restarting discards external transfer identities and suppression. Explorer recovery covers indexed Hyperlane messages; it does not recover every bridge transfer, pending source transaction, or allowance operation. A restart can therefore repeat source work.

The rebalancer automatically releases work only when preparation proves the primary was never submitted, its pending approval has finalized, or its primary transaction has finalized with an execution error. EVM and Tron use configured finality; Solana requires finalized signature status. Inventory resumes the remaining amount of its existing intent. Execution waits for a new balance snapshot after reconciliation changes action state.

`intentTTL` expires only uncommitted intents. It is not an alert threshold or permission to retry source-started work. Local diagnostics warn after one hour and include age, origin/destination, action and intent IDs, source hash, approval identity, bridge identity, and latest bridge status. One reserved inventory movement or deposit blocks new inventory work in that rebalancer instance.

Prometheus collects `hyperlane_rebalancer_oldest_inflight_action_age_seconds` and `hyperlane_rebalancer_inflight_actions` from local action state on every scrape, independently of RPC, balance-poll and Explorer synchronization. Labels are limited to warp route, origin/destination domains, action type, and the held reason. Action IDs and hashes remain in logs only. A restart loses local action state and can clear these metrics without resolving source effects; alert silence after restart is not recovery evidence.

Denylisted movable-collateral messages remain stored and reserved, but are excluded from the age/count gauges and blocked-action warnings. They remain visible in store logs and the `ignoredInProgress` synchronization count, including actions with settlement references. If the deny rule expires or is removed, they become observable again. Inventory movements and deposits retain their diagnostics even when their message is denylisted.

Initial operator alert targets (separate from transaction validity and reservation expiry):

```yaml
- alert: RebalancerActionReserved
  expr: hyperlane_rebalancer_oldest_inflight_action_age_seconds > 3600
  for: 10m
  labels:
    severity: warning
- alert: RebalancerActionReservedCritical
  expr: hyperlane_rebalancer_oldest_inflight_action_age_seconds > 21600
  for: 15m
  labels:
    severity: critical
```

These one-hour/six-hour thresholds detect sustained operational stalls before day-scale incidents; they are initial response targets, not measured bridge settlement guarantees. Tune legitimately slow routes with explicit route-specific alert rules. Before activation, the deployment owner must install these rules, route notifications to the rebalancer on-call, and verify a synthetic held action triggers the warning. Metrics and example rules in this repository alone do not install production alerts. Monitor scrape availability separately. Alerting never fails an action or permits a second send.

For actions that remain reserved:

1. Quiesce the affected rebalancer instance. Preserve its action/intent logs and hashes before stopping the process; do not use an automatic restart to clear the reservation.
2. Resolve every pending approval and primary source transaction against its source chain, including replacements or cancellations. A timeout, missing receipt, missing bridge API record, or expired Solana blockhash does not prove that the transfer never executed. Without a source hash, investigate signer history and provider records before permitting more source work.
3. If the source succeeded, establish whether destination delivery is still possible. Verify completed delivery or completed refund on chain, with the intended asset, amount, owner, and required finality. A provider's `failed` or `refund required` label is not completed-refund evidence. Do not retry while delivery or refund remains possible or unresolved.
4. Once all outstanding source and bridge effects are resolved, verify fresh inventory/collateral balances and residual ERC20 allowances. Reconcile any allowance while its earlier consumer can no longer execute. Preserve already delivered amounts when assessing the remaining deficit.
5. Resume or restart only after the resolved on-chain state is safe for fresh planning. If any outcome remains uncertain, keep the instance quiesced and escalate with the preserved identities.

Automatic Solana-expiry recovery, verified refund recovery, and durable restart recovery require separate work. There is deliberately no timeout-based or force-release operation in this stack.

## Operational follow-ups

The following availability and gas-efficiency improvements remain separate follow-ups; they do not relax the reservation rules above:

- **Estimation retry backoff.** Add bounded, per-route, in-memory backoff after a proven estimation failure and successful allowance cleanup. Apply the delay before the next approval, preserving exact approval, estimation, submission and cleanup ordering. Unresolved approval or source outcomes must continue blocking their origin independently of the backoff. Cover repeated failures, eventual retry, reset after success and unaffected routes in regression tests.
- **Explorer outage reconciliation.** Separate discovery of inflight transfers from reconciliation of known actions. Drain concurrent synchronization before finishing a cycle and continue independent reconciliation when Explorer discovery fails. Keep new submissions blocked while discovery is incomplete, and require a fresh balance snapshot after settlement changes. Test a failed discovery alongside successful reconciliation, no overlapping synchronization across cycles, and submission resumption only after complete discovery and fresh balances.
