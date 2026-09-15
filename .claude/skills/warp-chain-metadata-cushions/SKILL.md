---
name: warp-chain-metadata-cushions
description: Canonical local chain-metadata cushions applied before any warp command that lands transactions — raising `estimateBlockTime` so the CLI's confirmation budget isn't razor-thin — plus the mandatory restore-and-verify cleanup gate, and why a local single-RPC pin does NOT mitigate stale-gas OOG against the HTTP registry. Referenced by every warp deploy/update skill that submits transactions.
---

# Warp Chain-Metadata Cushions

Two warp failure modes come from the local registry's chain metadata being tuned for steady-state reads rather than for a command that lands transactions. Both are **preventable up front** with a local metadata edit, both are false-positive failures (nothing is wrong on chain), and both are covered by the same cleanup gate. This skill is the single source of those cushions so the copies in the deploy/send/update skills can't drift.

Apply the cushions **before** the first transaction-landing command, not after the first failure — a mid-run abort burns gas, can leave a dangling approval or an orphaned contract, and forces a fresh re-run.

## Failure mode 1 — confirmation-timeout on a tx that actually landed

**Signature:** `Timeout (Xms) waiting for N block confirmations for tx 0x…`, where the transaction already succeeded on chain (check the receipt: `status: 1`).

**Root cause:** the confirmation budget is `max(confirmations × estimateBlockTime × 2, 30s)` — see `MultiProvider` in `typescript/sdk`, where `estimateBlockTime` is registry seconds and the floor is a 30s minimum. On ethereum at the default `estimateBlockTime: 13` with `confirmations: 2`, that is 52s. Short-block chains do **not** get a proportionally tiny budget: at `estimateBlockTime: 3` the computed value is 12s, so the 30s floor applies instead. A block window slower than nominal, or ordinary receipt latency at the RPC provider, blows the budget while the transaction is perfectly fine, and the CLI gives up client-side and aborts the run.

**Fix:** raise `estimateBlockTime` for the affected chains in the **local** registry metadata before running. This survives the GCP RPC-override merge, unlike re-pinning RPCs — do **not** re-pin RPCs for this failure mode.

| Chain      | Default | Budget at default | Cushion | Budget after |
| ---------- | ------- | ----------------- | ------- | ------------ |
| `ethereum` | 13      | 52s               | **60**  | 240s         |
| `bsc`      | 3       | 30s (floored)     | **30**  | 120s         |
| `tron`     | 3       | 30s (floored)     | **30**  | 120s         |

Budgets assume `confirmations: 2` — read the chain's actual value, since it scales the result linearly. Ethereum needs the largest cushion: mainnet under load routinely exceeds the smaller values, and the abort lands mid-sequence. Treat the table as a floor — raise further on a chain that still times out rather than retrying into the same budget. Any short-block or confirmation-timeout-prone chain not listed takes the same treatment.

## Failure mode 2 — stale-gas OOG from a lagging RPC replica

**Signature:** out-of-gas on a proxy `initialize` immediately after a successful implementation deploy, on opstack / multi-RPC chains (`base`, `optimism`, drpc-routed chains).

**Root cause:** read-after-write lag across a chain's load-balanced private RPCs. The implementation deploys, then `initialize` is gas-estimated against a replica that hasn't indexed the new contract yet, so the estimate comes back EOA-sized (~25k) and the transaction runs out of gas.

**This is NOT a false positive.** Unlike failure mode 1, the transaction genuinely reverted on chain: the deploy is incomplete, contracts from the same run may be orphaned, and the deployer nonce has advanced. It needs retry and reconciliation of what actually landed — never restore cushions and report the run complete on the strength of the tx having been "sent".

**A local single-RPC pin usually does not reach the CLI.** `/start-http-registry` outside CI resolves metadata through the environment registry, which merges GCP secret metadata **after** the filesystem layer. The merge replaces the `rpcUrls` array wholesale rather than concatenating it, so for any chain that has a secret — which is every chain we run private RPCs on, i.e. exactly the multi-RPC chains this failure mode affects — a filesystem pin is silently discarded. A chain with no secret keeps its filesystem `rpcUrls`, so the edit does work there; that is the minority case and not the one you are trying to fix.

(`estimateBlockTime` survives the same merge precisely because the secret layer carries no value for it — only `rpcUrls`, `gnosisSafeApiKey` and `blockExplorers` are overridden. That asymmetry is why failure mode 1's cushion works and this one's does not.)

There is no supported per-chain RPC pin: nothing in the registry server's interface exposes one, and the CI env-var path is an alternative to the GCP path rather than a layer above it. Treat this failure mode as unmitigated. **Never claim a pin is in place without proving it:** read the served metadata for the chain from the running HTTP registry and confirm the RPC list is exactly the intended one. If it isn't, the pin didn't take — say so and proceed knowing the failure mode is live rather than assuming protection you don't have.

## Verify, don't assume a previous step applied them

Every skill that lands transactions applies this itself — **never assume an earlier step in the chain did it**. A chain can be entered part-way (a route deployed in an earlier session, a send test run standalone, an update against an existing route), the local registry can have been reset or re-cloned between steps, and a prior step's cleanup gate may have already restored the defaults by design.

The operation is idempotent: read the current local `estimateBlockTime` for each chain in the route, and only raise a value that is below the cushion. A value already at or above it is left alone — never lower it.

**Record the pre-edit value in the run log before editing, and treat an unexplained cushion as orphaned.** A run that dies between editing and cleanup leaves a raised value with no owner; if later runs defer to "whoever applied it", the edit is inherited forever and the local registry drifts from canonical permanently. So: if the run log records who raised it and that run is still live, leave it. Otherwise it is orphaned — take ownership, restore it to the canonical value at your own cleanup gate, and note the adoption.

## Cleanup gate (mandatory)

Every cushion above is a **local registry edit**. After the run completes — green or failed — restore the original values and confirm the registry working tree is clean:

```bash
git -C $HYPERLANE_REGISTRY diff
```

A left-behind `estimateBlockTime` bump silently drifts the local registry from canonical for every later run, and can be committed by accident into a registry PR. The gate is not satisfied by intent to restore — verify the diff is clean, and if a warp-route config file is legitimately modified, confirm the metadata files specifically are not.

## Consumers

`/warp-deploy-init-route` (the deploy), `/warp-deploy-send-test` (the sends — the same confirmation-timeout aborts a send after the ERC20 approval is mined but before the `transferRemote`, leaving a dangling allowance and no dispatch), `/warp-deploy-update-owners` (the ownership-transfer `warp apply`), `/warp-update`, `/warp-update-extend` — every skill that submits transactions through the CLI.
