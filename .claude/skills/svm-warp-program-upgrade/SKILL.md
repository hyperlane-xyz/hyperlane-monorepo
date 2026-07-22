---
name: svm-warp-program-upgrade
description: Upgrade a deployed Sealevel (SVM) warp-route token or IGP program to a newer contract version (e.g. to enable token/IGP fee support), driven by warp apply. Use when asked to upgrade, bump, or migrate an SVM warp/IGP program to a fee-enabled or newer version, or when a config diff reports a contractVersion mismatch on a Sealevel chain.
---

# SVM Warp Program Upgrade

Upgrade a deployed Sealevel warp-route token program (collateral/synthetic/native/cross-collateral) or IGP program to a newer on-chain `contractVersion` — most commonly to move an existing route onto a fee-enabled program build.

There is **no standalone `warp upgrade` CLI command.** The upgrade runs automatically as part of `hyperlane warp apply`: when the expected `contractVersion` in the compiled program config differs from the on-chain version AND program bytes are supplied, the SVM token module calls `prepareProgramUpgrade` (`typescript/svm-sdk/src/deploy/program-upgrade.ts`) before its config-update step.

## When to Use

- "upgrade the solanamainnet <TOKEN> warp program to the fee-enabled version"
- "bump the SVM IGP program to vX"
- "warp check says contractVersion mismatch on eclipsemainnet — upgrade it"
- Any request to migrate a deployed Sealevel warp/IGP program to a newer program build

## What the Upgrade Actually Does

`prepareProgramUpgrade` (verify against source before relying on details):

1. **Version compare.** Reads on-chain `contractVersion`, compares to expected. Equal → no-op (returns null). Expected older → **throws** (no downgrades). Expected newer → proceeds.
2. **Immutable check.** Reads the program's upgrade authority. If the program has none (immutable), it **asserts/throws** — cannot upgrade.
3. **Extend program-data if needed.** Computes `additionalBytes = newProgramBytes.length - currentMaxProgramLen`. If `> 0`, emits a single `ExtendProgramChecked` instruction (`getExtendProgramCheckedInstruction`, loader.ts) sized to exactly the deficit. The checked variant is required on Agave 3.0+ (`enable_extend_program_checked` gate). No fixed padding amount — it extends by exactly what the new binary needs.
4. **Buffer create + write.** Creates a buffer account and writes the new program bytes using the **submitter/payer key** (executed immediately; no upgrade authority needed for this part).
5. **Transfer buffer authority** to the upgrade authority if payer ≠ upgrade authority.
6. **Emit the upgrade instruction** as an authority transaction — this and the extend require the **upgrade authority** to sign.

So the run splits into two groups:

- **Payer-executed immediately:** buffer create/write (+ optional buffer-authority transfer).
- **Authority transactions (need the upgrade authority signature):** `ExtendProgramChecked` (if any) + the `Upgrade` instruction. These are surfaced as `AnnotatedSvmTransaction`s. If the upgrade authority == the submitter key, `warp apply` submits them; otherwise they are written for the authority to sign (e.g. via a `file` submitter / Squads).

## Inputs

- **Warp route ID** (e.g. `USDC/solana-...`) — required.
- **Chain(s)** — which Sealevel chain(s) to upgrade.
- **Submitter key** for the chain (`--key.sealevel`) — funds/writes the buffer.
- **Upgrade authority** — who signs the extend + upgrade. If it is not the submitter key, expect a `file`/Squads submitter and plan to route the authority txs to the owner.
- Confirmation that the compiled config carries the **new program bytes** and the **target `contractVersion`** (this is what the deploy/config pipeline resolves; a version bump without program bytes does nothing).

If any of these is missing, ask before proceeding.

## Execution Flow

### Step 1 — Read current on-chain version

Read the deployed program's config to capture the current `contractVersion` and confirm it is older than the target. Use `hyperlane warp read` (or `warp check`) against the route so you can show the user current vs expected version and the upgrade authority.

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp read \
  --registry http://localhost:<port> \
  -w <WARP_ROUTE_ID>
```

Confirm:

- expected version **>** current version (equal = nothing to do; expected older = will throw)
- the program has an upgrade authority (not immutable)
- who the upgrade authority is (submitter vs external owner)

### Step 2 — Start the HTTP registry

The upgrade needs private RPC overrides for the Sealevel chain. Start it per `/start-http-registry` **with `--writeMode`** (the upgrade persists on-chain). Note the port + task ID.

### Step 3 — Dry-run / preview

Preview the apply so the user sees exactly which programs will be extended + upgraded and the version transitions, before spending SOL on buffer writes.

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp apply \
  --registry http://localhost:<port> \
  --key.sealevel "$SEALEVEL_KEY_VAR" \
  -w <WARP_ROUTE_ID> \
  --dry-run
```

Look for the annotations `Extend <label>: +N bytes` and `Upgrade <label>: <old> → <new>`. Show these to the user. If no upgrade annotation appears, the version already matches or no program bytes were supplied — stop and report that.

### Step 4 — Run the upgrade

Re-run without `--dry-run`. If the upgrade authority differs from the submitter key, supply a strategy with a `file` submitter for the Sealevel chain so the authority (extend + upgrade) transactions are written out for the owner to sign.

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp apply \
  --registry http://localhost:<port> \
  --key.sealevel "$SEALEVEL_KEY_VAR" \
  [--strategy ~/.hyperlane/strategies/<owner>-strategy.yaml]  # if authority != submitter
  --receipts-dir /tmp/<route>-svm-upgrade-txs \
  -w <WARP_ROUTE_ID> \
  --yes
```

Buffer create/write is executed immediately by the submitter key. The extend + upgrade either execute (authority == submitter) or land in the receipts dir for the owner to sign.

### Step 5 — Verify

Re-read the program and confirm on-chain `contractVersion` now equals the target. If the authority txs were written to a file, the version will only change **after** the owner executes them — say so explicitly.

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp read \
  --registry http://localhost:<port> -w <WARP_ROUTE_ID>
```

### Step 6 — Recreate ALTs

A program upgrade can change the account set for transfers. After any successful upgrade, **recreate the SVM Address Lookup Tables** for the route — run `/svm-warp-alt-manage` (`hyperlane warp alt create`). Then `hyperlane warp alt check` to confirm no drift.

### Step 7 — Stop the HTTP registry

Stop it per `/stop-http-registry`, even on failure.

## Caveats

- **No downgrades.** Expected version older than on-chain → hard error. Don't try to "roll back" via this path.
- **Immutable programs can't be upgraded.** If there's no upgrade authority, stop and escalate.
- **Two-key reality.** The submitter/payer key pays for and writes the buffer; the **upgrade authority** must sign the extend + upgrade. These are frequently different (owner = Squads multisig). Plan for a `file` submitter and owner execution.
- **Version bump alone is inert.** If the config carries a new `contractVersion` but no program bytes, `prepareProgramUpgrade` never runs a binary upgrade — only the config-update path. Ensure the program build/bytes are wired in.
- **Extend sizing is exact**, computed from the new binary vs current program-data capacity; it is not a fixed 10 KiB. If the binary shrank or fits, no extend instruction is emitted.
- **Always follow with ALT recreation** (Step 6) — stale ALTs after an account-layout change cause transfer failures.
