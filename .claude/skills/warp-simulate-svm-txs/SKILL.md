---
name: warp-simulate-svm-txs
description: Simulate pending Sealevel (SVM) warp-route governance txs — signed directly or via a Squads multisig — by forking Solana mainnet locally with surfpool, replaying the exact transactions, then running warp check against the desired registry config. Use to verify that a not-yet-submitted SVM governance change produces the intended on-chain config before it is signed/executed.
---

# Warp Simulate SVM Txs

Verify that a pending Sealevel (SVM) warp-route governance change produces the
**desired warp route config** before it is submitted to mainnet or executed through
a Squads multisig. This forks Solana mainnet locally with **surfpool**, replays the
**exact transactions** that will be signed (base58 wire txs, not a re-derived
approximation), then runs `warp check` against the target registry config.

This is the SVM side of the "fork → replay → check" loop (the Solana analog of
`/warp-simulate-safe-txs`). It catches wrong owners, wrong ISMs, missing router
enrollments, or bad gas/fee config that would otherwise only surface after the txs
are executed on-chain.

Unlike the EVM Safe flow, SVM warp governance is same-domain: there is **no ICA
fan-out and no cross-fork relay** to worry about. Impersonation is handled by
surfpool's `--skip-signature-verification`, so the txs replay as-is even though you
don't hold the authority's key.

## When to use

- An engineer has an SVM warp-route config change (owner/ISM/router/gas/fee) and
  asks "do these txs lead to the desired config in registry PR #XXXX?"
- Before signing or executing any SVM warp-route governance transaction, including
  ones routed through a Squads vault.

## Input Parameters

| Parameter       | Required | Description                                                                                                                                                   |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warp_route_id` | Yes      | The warp route ID being changed, e.g. `SOL/solanamainnet-...`.                                                                                                |
| `svm_txs`       | Yes      | The governance transactions to replay, as a `PrintableSvmTransaction[]` file — the output of `warp apply --submitter file`, or a Squads export in that shape. |
| `target_config` | Yes      | The desired config to check against — usually a hyperlane-registry PR branch. Serve it via the local HTTP registry.                                           |

## Prerequisites

- **surfpool** installed: the CLI `warp fork` SVM path runs a locally-installed
  `surfpool` binary (`>= 1.5.0`) on `PATH` — there is **no Docker fallback**. Install
  the pinned, checksum-verified release the way CI does — see the `Install surfpool`
  step in `.github/workflows/test-cli-e2e.yml` (a pinned `v1.5.0` tarball verified
  against its SHA-256); do **not** pipe the mutable `run.surfpool.run` installer to a
  shell. If it's missing, `warp fork` aborts before replaying anything with a
  "surfpool 1.5.0+ is required" error.
- Monorepo root: `MONOREPO_ROOT=$(git rev-parse --show-toplevel)`. Prefix CLI
  commands with `cd $MONOREPO_ROOT &&`.
- A local HTTP registry serving the **target** (PR) config (use
  `/start-http-registry` pointed at the PR branch, or pass `--registry`). `warp fork`
  reads the warp route from this registry to decide which chain to fork.
- A scratch dir, e.g. `WORK=$(mktemp -d)`.

## Instructions

### Step 1 — Produce the transactions to replay (`PrintableSvmTransaction[]`)

If you don't already have the tx file, generate it with `warp apply` and the **file
submitter**, which writes the governance txs (as base58 wire transactions) to a file
instead of submitting them:

```yaml
# strategy.yaml — route the Sealevel chain's txs to a file
<sealevelChain>:
  submitter:
    type: file
    chain: <sealevelChain>
    filepath: <WORK>/svm-txs.json
```

```test
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp apply \
  --warpRouteId $WARP_ROUTE_ID --registry http://localhost:3333 \
  --strategy $WORK/strategy.yaml
```

The result is `$WORK/svm-txs.json` — a flat `PrintableSvmTransaction[]` array (each
element carries `transaction_base58`, and optionally `waitForSlotAdvance`). A Squads
proposal export in the same shape works too.

### Step 2 — Build the fork-config

`warp fork` accepts a per-chain fork-config; the Sealevel slice takes the tx file by
path (`SvmRawForkConfigSchema`'s `{ path }` form — the array is read from disk):

```yaml
# $WORK/fork-config.yaml
<sealevelChain>:
  path: <WORK>/svm-txs.json
```

(Inline `{ transactions: [...] }` is also accepted, but `path` avoids embedding
base58 blobs.)

### Step 3 — Fork, replay, and serve the overlaid registry

Serve the target (PR) registry so fork/check read the intended addresses, then run
`warp fork` in the background (it forks the route's Sealevel chain with surfpool,
replays the txs under skip-sigverify/skip-blockhash, and serves an overlaid registry
whose Sealevel RPC points at the local fork):

```test
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp fork \
  --warpRouteId $WARP_ROUTE_ID --registry http://localhost:3333 \
  --fork-config $WORK/fork-config.yaml --port 8545
```

- Run it with `run_in_background: true` (the command serves HTTP and holds the fork).
- The overlaid registry is served on `port - 10` (e.g. `8535` for `--port 8545`).
- Note the task/shell ID so you can stop it in Step 5.

> **Finalization note:** surfpool's copy-on-read fetches the datasource at
> **finalized** commitment. Mainnet state is long-finalized, so this is a non-issue
> in practice. (Only matters when forking a freshly-written local validator.)

### Step 4 — warp check against the desired config

```test
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp check \
  --warpRouteId $WARP_ROUTE_ID --registry http://localhost:8535
```

Point `--registry` at the **served fork registry** (`port - 10`) so `warp check`
reads the fork's post-replay on-chain state. Expect **zero violations** — that means
the replayed txs produce exactly the target config.

### Step 5 — Cleanup (mandatory)

Stop the background `warp fork` process (`KillShell` with its ID). It terminates the
local `surfpool` process (SIGTERM) — don't leave it running.

### Step 6 — Report

- PASS/FAIL with the concrete config deltas (owner/ISM/router/gas/fee) vs the target
  config.
- Anything not covered.

## Gotchas (learned)

- surfpool forks the datasource's **current head**; there is no fork-at-slot flag
  (unlike anvil's `--fork-block-number`). Config validation against current mainnet
  state is exactly what this loop does.
- Impersonation is global `--skip-signature-verification` (handled inside the SVM
  fork path) — you don't need the authority's key, and Squads vault PDAs sign via
  program CPI seeds so they need nothing special.
- The tx file is the **exact** `warp apply --submitter file` output; don't
  re-serialize or re-sign it.
- `warp check` works for Sealevel — it reads the fork's on-chain PDA state and diffs
  against the target config.

## Related skills

- `/warp-fork` — fork a warp route's chains (per-protocol: anvil for EVM, surfpool for SVM).
- `/warp-simulate-safe-txs` — the EVM/Safe analog of this loop.
- `/start-http-registry` — serve a local/PR registry for fork+check.
- `/warp-route-check` — standalone warp check.
