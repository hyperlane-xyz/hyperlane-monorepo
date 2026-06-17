---
name: warp-update-propose
description: Orchestrator skill that takes a warp-apply receipts directory and proposes each batch to its corresponding multisig signer — Safe Transaction Service via `safes/propose-warp-batch.ts` for EVM batches (auto-detects governance context: AW / Foundation / Regular / etc. per filename), Squads via `squads/propose-warp-batch.ts` for SVM batches. Persists a per-ticket proposal summary at `~/.hyperlane/proposals/<ticket-id>.yaml` so the human can track signing progress in Heimdall or Squads.
---

# Warp Update — Propose

Run AFTER `/warp-update` (Wave 5; pending) — or any other flow — has executed `hyperlane warp apply` and emitted a receipts directory of per-chain Safe TX Builder JSON files + Squads instruction files. This skill takes those receipts and proposes each batch to its appropriate signer, dispatching automatically by protocol + governance context.

The heavy lifting lives in two infra scripts:

- `typescript/infra/scripts/safes/propose-warp-batch.ts` — reads `combined-chainId<id>-safe<addr8>-<ts>-receipts.json`, auto-detects which governance Safe owns each batch (AW / Foundation / Regular / Irregular / oUSDT), and posts via Safe Transaction Service using the Turnkey EvmLegacyDeployer signer.
- `typescript/infra/scripts/squads/propose-warp-batch.ts` — reads `<chain>-file-<ts>-receipts.json`, rehydrates each tx's `transaction_base58` back into Solana `TransactionInstruction[]`, and proposes via `submitProposalToSquads` using the Turnkey SealevelDeployer signer.

This skill orchestrates running both, surfaces a CONFIRM gate before any propose call lands on chain, and writes a summary the human can use to find proposals in Heimdall / Squads UI.

## Input

- **Linear ticket ID** (required, e.g. `AW-123`) — namespaces the proposal summary artifact.
- **Receipts directory** (required) — absolute path to the dir `warp apply` wrote into. Typically `/tmp/<customer>-<warp-route-id>-txs/` per the `/warp-update` strategy file's `--receipts-dir` arg.
- **Dry-run** (optional, default false) — if set, both underlying scripts run with `--dry-run` (deserialize + log without posting).
- **Chain filter** (optional, comma-separated) — limits which files are proposed. Passed through to both scripts as `--chain-filter`.

If the ticket ID or receipts dir is missing, ask the user.

### Artifact Context (Optional)

If `~/.hyperlane/update-context/<ticket-id>.yaml` exists (produced by `/warp-update-resolve-artifacts`), auto-load it for cross-referencing. Use it to enrich the inventory output (Step 1) with the artifact types each batch covers (router / proxyAdmin / fee:routing / fee:linear / ism / hook). If the file is missing, fall back to filename-only classification — the propose scripts work either way.

---

## Step 1: Inventory the Receipts Directory

List the JSON files in the directory and classify each by filename pattern:

```bash
ls <receipts-dir>/*.json
```

Two recognized patterns (from `typescript/cli/src/apply/warp.ts:writeCombinedBundles` and `typescript/deploy-sdk/src/AltVMFileSubmitter.ts`):

- `combined-chainId<id>-safe<addr8>-<ts>-receipts.json` → EVM Safe batch (`gnosisSafeTxBuilder` submitter)
- `<chain>-file-<ts>-receipts.json` → SVM batch (`AltVMFileSubmitter`)

For each file, derive:

- Protocol (EVM / SVM)
- Chain name
- For EVM: the 8-hex safe prefix → resolve to a full safe address by cross-referencing every `GovernanceType` via the existing `getSafesByGovernanceForChain(chain)` helper. The first matching governance type wins.
- For SVM: the chain's Squads `multisigPda` from `squadsConfigs[chain]`
- Tx count from the file body (parse JSON, count `transactions[]` for EVM or `PrintableSvmTransaction[]` for SVM)

Files matching neither pattern: list as "skipped" with a clear reason. The propose scripts also skip them, so this is just a visibility pass.

Show the user the inventory:

```
EVM Safe batches (3 files):
  - combined-chainId1-safe3965AC3D-1234-receipts.json
      → ethereum, AW Safe (0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6), 4 txs
  - combined-chainId42161-safe645FE065-1234-receipts.json
      → arbitrum, AW ICA (0x645FE06507C8a188494d3E755B248a8dbF3bd875), 3 txs
  - combined-chainId8453-safe8Ff4c563-1234-receipts.json
      → base, Foundation warpFees Safe (0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0), 2 txs

SVM Squads batches (1 file):
  - solanamainnet-file-1234-receipts.json
      → solanamainnet, Squads multisig EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4, 2 instructions

Skipped (0 files): —
```

If an artifact context is loaded, append per-batch artifact-coverage info ("this batch covers router on arbitrum + proxyAdmin on arbitrum") drawn from `groupedByOwner` in the context.

---

## Step 2: Cross-Reference Against Artifact Context (if loaded)

For each EVM batch:

- Look up the resolved safe address in the artifact context's `groupedByOwner` table.
- Confirm the governance type matches. If the context says `Foundation` but Step 1 resolved `AW`, surface a warning — likely a stale artifact context or a deploy.yaml drift.

For each SVM batch:

- Look up the multisig PDA in `squadsConfigs[chain]`.
- Cross-check against any Squads-type owners in the artifact context.

These are warnings only — they don't block the propose. If anything is genuinely wrong the human catches it at the CONFIRM gate.

---

## Step 3: Confirmation Gate

Show the full proposal plan in a single message:

```
About to propose <N> batches across <M> chains for ticket <ticket-id>.

EVM:
  - ethereum / AW Safe / 4 txs
  - arbitrum / AW ICA / 3 txs
  - base / Foundation warpFees Safe / 2 txs

SVM:
  - solanamainnet / Squads (EvptYJrj…URwJ) / 2 instructions

Signers:
  - EVM via Turnkey EvmLegacyDeployer (0xa7ECcdb9…d9Ba — AW + Foundation owner)
  - SVM via Turnkey SealevelDeployer

Dry-run: <yes/no>
Output artifact: ~/.hyperlane/proposals/<ticket-id>.yaml
```

End the message with:

```test
[CONFIRM: Propose <N> batches for <ticket-id>]
```

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

Do not proceed to Step 4 until the user confirms.

---

## Step 4: Execute Per Protocol

Run the two scripts in sequence (EVM first, then SVM). Both scripts handle per-file partial-success internally; one file failing doesn't block the rest.

### 4a. EVM Safe batches (skip if zero EVM files)

```bash
pnpm -C typescript/infra exec tsx scripts/safes/propose-warp-batch.ts \
  --directory <receipts-dir> \
  [--dry-run] \
  [--chain-filter <chains>]
```

The script:

- Walks `combined-*-safe*-receipts.json` files in the directory
- Auto-detects governance type per filename safe prefix via `getSafesByGovernanceForChain`
- Initializes the Turnkey EvmLegacyDeployer signer via `createTurnkeySigner('mainnet3', TurnkeyRole.EvmLegacyDeployer)`
- Wraps each file's `transactions[]` into a single multiSend via `createSafeTransaction(safeSdk, txData, /*onlyCalls=*/true)`
- Calls the refactored `proposeSafeTransaction(...)` which uses `signer._signTypedData` (Turnkey signs the EIP-712 hash directly — no raw key extraction)
- Prints per-file result + final summary table

Capture the script's stdout/stderr. Map each per-file result back to the inventory.

### 4b. SVM Squads batches (skip if zero SVM files)

```bash
pnpm -C typescript/infra exec tsx scripts/squads/propose-warp-batch.ts \
  --directory <receipts-dir> \
  [--dry-run] \
  [--chain-filter <chains>]
```

The script:

- Walks `<chain>-file-*-receipts.json` files
- Filters to Sealevel chains
- Initializes the Turnkey SealevelDeployer signer via `getTurnkeySealevelDeployerSigner(...)`
- Rehydrates each tx's `transaction_base58` via `VersionedTransaction.deserialize` + `TransactionMessage.decompile`
- Calls `submitProposalToSquads(chain, instructions, mpp, signerAdapter, memo)` per file
- Prints per-file result + final summary table

Capture the script's output similarly.

### Per-script failure handling

If a script exits non-zero (every file failed), DO NOT abort the orchestrator — log the protocol's failure, mark all its inventory entries as failed, and continue to the other protocol. Total-orchestrator-failure (both scripts had zero successes) results in a non-zero exit at the end.

---

## Step 5: Persist Proposal Summary

Write `~/.hyperlane/proposals/<ticket-id>.yaml`:

```yaml
ticket: <ticket-id>
proposedAt: '<ISO-8601 timestamp>'
receiptsDirectory: <abs-path>
dryRun: <true|false>

evm:
  proposed:
    - file: combined-chainId1-safe3965AC3D-1234-receipts.json
      chain: ethereum
      safe: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6'
      governanceType: AW
      safeTxHash: '0xabc...'
      txCount: 4
  failed:
    - file: <filename>
      chain: <chain>
      safe: <safe>
      reason: <error>
      txCount: <n>
  skipped:
    - file: <filename>
      reason: <reason>

svm:
  proposed:
    - file: solanamainnet-file-1234-receipts.json
      chain: solanamainnet
      multisigPda: EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4
      txCount: 2
  failed: []
  skipped: []

summary:
  totalProposed: <n>
  totalFailed: <n>
  totalSkipped: <n>
```

The artifact is consumed by humans who need to track proposal signing progress. Heimdall's UI also surfaces the EVM proposals once Safe Transaction Service has them indexed; Squads UI surfaces the SVM ones.

---

## Step 6: Hand Off

Tell the user:

> **Proposal summary saved to `~/.hyperlane/proposals/<ticket-id>.yaml`.**
>
> Where to track signing:
>
> - **AW Safe + Foundation Safe proposals**: visible in Heimdall (https://hyperlane.usehaggis.com) where executioners — including Haggis — can sign + execute. Heimdall polls Safe Transaction Service periodically; allow a minute for new proposals to appear.
> - **Squads proposals**: surface in the Squads UI at https://app.squads.so/ (or chain-specific equivalent). Solana signers review + sign there.
> - **Customer / Regular Safe proposals**: pushed to Safe Transaction Service directly. The customer signs in their own Safe app at `https://app.safe.global/transactions/queue?safe=<chain-shortname>:<safe-address>`. They'll need to import the safe in their app first if it's not already there.

---

## Notes

- **Side effects**: this skill POSTs proposals to Safe Transaction Service / creates Squads on-chain proposals. The actions are reversible — Safe TX Service has a delete-tx API, Squads has a cancel-proposal instruction — but human signers can move quickly. Use `--dry-run` first if anything in the inventory looks off.
- **Idempotency**: re-running with the same receipts dir produces DUPLICATE proposals. Either delete the prior proposals (via the safes script's `safes/delete-tx.ts` or squads' `cancel-proposal.ts`) or don't re-run the same dir.
- **No GCP secrets in this skill**: secret access happens inside the propose scripts, not at the orchestrator level. The skill just shells out.
- **What "auto-detects governance" means**: the safes script walks every `GovernanceType` enum value, calls `getGovernanceSafes(type)[chain]`, and matches the filename's 8-hex prefix against the resolved safe. A single receipts dir can mix multiple governance contexts (router via AW, fee contracts via Foundation, etc.) — the script handles them all in one run.
