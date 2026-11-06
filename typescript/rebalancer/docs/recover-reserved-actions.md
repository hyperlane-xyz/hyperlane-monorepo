# Recovering reserved rebalancer actions

Action state and origin allowance locks are in memory. Restarting discards external transfer identities and suppression. Explorer recovery covers indexed Hyperlane messages; it does not recover every bridge transfer, pending source transaction, or allowance operation. A restart can therefore repeat source work.

The rebalancer automatically releases work only when preparation proves the primary was never submitted, its pending approval has finalized, or its primary transaction has finalized with an execution error. EVM and Tron use configured finality; Solana requires finalized signature status. Inventory resumes the remaining amount of its existing intent. Execution waits for a new balance snapshot after reconciliation changes action state.

`intentTTL` is an alert threshold for source-started actions, not permission to retry. Alert on `Action blocked beyond intentTTL; reconcile before retry or restart`. Logs include age, origin/destination, action and intent IDs, source hash, approval identity, bridge identity, and latest bridge status. One reserved inventory movement or deposit blocks new inventory work in that rebalancer instance.

For actions that remain reserved:

1. Quiesce the affected rebalancer instance. Preserve its action/intent logs and hashes before stopping the process; do not use an automatic restart to clear the reservation.
2. Resolve every pending approval and primary source transaction against its source chain, including replacements or cancellations. A timeout, missing receipt, missing bridge API record, or expired Solana blockhash does not prove that the transfer never executed. Without a source hash, investigate signer history and provider records before permitting more source work.
3. If the source succeeded, establish whether destination delivery is still possible. Verify completed delivery or completed refund on chain, with the intended asset, amount, owner, and required finality. A provider's `failed` or `refund required` label is not completed-refund evidence. Do not retry while delivery or refund remains possible or unresolved.
4. Once all outstanding source and bridge effects are resolved, verify fresh inventory/collateral balances and residual ERC20 allowances. Reconcile any allowance while its earlier consumer can no longer execute. Preserve already delivered amounts when assessing the remaining deficit.
5. Resume or restart only after the resolved on-chain state is safe for fresh planning. If any outcome remains uncertain, keep the instance quiesced and escalate with the preserved identities.

Automatic Solana-expiry recovery, verified refund recovery, and durable restart recovery require separate work. There is deliberately no timeout-based or force-release operation in this stack.

## Operational follow-ups

The following improvements are separate work before live activation:

- **Estimation retry backoff.** Add bounded, per-route, in-memory backoff after a proven estimation failure and successful allowance cleanup. Apply the delay before the next approval, preserving exact approval, estimation, submission and cleanup ordering. Unresolved approval or source outcomes must continue blocking their origin independently of the backoff. Cover repeated failures, eventual retry, reset after success and unaffected routes in regression tests.
- **Explorer outage reconciliation.** Separate discovery of inflight transfers from reconciliation of known actions. Drain concurrent synchronization before finishing a cycle and continue independent reconciliation when Explorer discovery fails. Keep new submissions blocked while discovery is incomplete, and require a fresh balance snapshot after settlement changes. Test a failed discovery alongside successful reconciliation, no overlapping synchronization across cycles, and submission resumption only after complete discovery and fresh balances.
