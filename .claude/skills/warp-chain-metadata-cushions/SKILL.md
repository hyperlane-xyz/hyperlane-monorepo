---
name: warp-chain-metadata-cushions
description: Canonical local chain-metadata cushions applied before any warp command that lands transactions — raising `estimateBlockTime` so the CLI's confirmation budget isn't razor-thin, and pinning a single RPC on multi-RPC chains so gas estimates aren't read from a lagging replica — plus the mandatory restore-and-verify cleanup gate. Referenced by every warp deploy/update skill that submits transactions.
---

# Warp Chain-Metadata Cushions

Two warp failure modes come from the local registry's chain metadata being tuned for steady-state reads rather than for a command that lands transactions. Both are **preventable up front** with a local metadata edit, both are false-positive failures (nothing is wrong on chain), and both are covered by the same cleanup gate. This skill is the single source of those cushions so the copies in the deploy/send/update skills can't drift.

Apply the cushions **before** the first transaction-landing command, not after the first failure — a mid-run abort burns gas, can leave a dangling approval or an orphaned contract, and forces a fresh re-run.

## Failure mode 1 — confirmation-timeout on a tx that actually landed

**Signature:** `Timeout (Xms) waiting for N block confirmations for tx 0x…`, where the transaction already succeeded on chain (check the receipt: `status: 1`).

**Root cause:** the CLI's confirmation budget is `confirmations × estimateBlockTime × 2` seconds. On a chain whose registry `estimateBlockTime` is 3s that budget is as low as ~6s; on ethereum at the default 13s with `confirmations: 2` it is 52s. A block window slower than nominal, or ordinary receipt latency at the RPC provider, blows the budget while the transaction is perfectly fine. The CLI gives up client-side and aborts the run.

**Fix:** raise `estimateBlockTime` for the affected chains in the **local** registry metadata before running. This survives the GCP RPC-override merge, unlike re-pinning RPCs — do **not** re-pin RPCs for this failure mode.

| Chain      | Default | Cushion | Resulting budget (at `confirmations: 2`) |
| ---------- | ------- | ------- | ---------------------------------------- |
| `ethereum` | 13      | **60**  | 240s                                     |
| `bsc`      | 3       | **30**  | 120s                                     |
| `tron`     | 3       | **30**  | 120s                                     |

Ethereum needs the largest cushion: mainnet under load routinely exceeds the smaller values, and the abort lands mid-sequence. Treat the table as a floor — raise further on a chain that still times out rather than retrying into the same budget. Any short-block or confirmation-timeout-prone chain not listed takes the same treatment.

## Failure mode 2 — stale-gas OOG from a lagging RPC replica

**Signature:** out-of-gas on a proxy `initialize` immediately after a successful implementation deploy, on opstack / multi-RPC chains (`base`, `optimism`, drpc-routed chains).

**Root cause:** read-after-write lag across a chain's load-balanced private RPCs. The implementation deploys, then `initialize` is gas-estimated against a replica that hasn't indexed the new contract yet, so the estimate comes back EOA-sized (~25k) and the transaction runs out of gas.

**Fix:** pin the affected chain to a single RPC in the local registry metadata for the duration of the run. Applies to commands that deploy contracts; a route with no opstack / multi-RPC chains needs no pin.

## Verify, don't assume a previous step applied them

Every skill that lands transactions applies this itself — **never assume an earlier step in the chain did it**. A chain can be entered part-way (a route deployed in an earlier session, a send test run standalone, an update against an existing route), the local registry can have been reset or re-cloned between steps, and a prior step's cleanup gate may have already restored the defaults by design.

The operation is idempotent: read the current local `estimateBlockTime` for each chain in the route, and only raise a value that is below the cushion. A value already at or above it is left alone — never lower it. When the cushions were already in place on entry, note that and leave the restore to whoever applied them; when this skill applied them, its own cleanup gate is yours to honor.

## Cleanup gate (mandatory)

Every cushion above is a **local registry edit**. After the run completes — green or failed — restore the original values and confirm the registry working tree is clean:

```bash
git -C $HYPERLANE_REGISTRY diff
```

A left-behind `estimateBlockTime` bump or single-RPC pin silently drifts the local registry from canonical for every later run, and can be committed by accident into a registry PR. The gate is not satisfied by intent to restore — verify the diff is clean, and if a warp-route config file is legitimately modified, confirm the metadata files specifically are not.

## Consumers

`/warp-deploy-init-route` (the deploy), `/warp-deploy-send-test` (the sends — the same confirmation-timeout aborts a send after the ERC20 approval is mined but before the `transferRemote`, leaving a dangling allowance and no dispatch), `/warp-update`, `/warp-update-extend` — every skill that submits transactions through the CLI.
