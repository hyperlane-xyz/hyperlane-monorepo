---
name: warp-run-log
description: Maintain the durable, per-run log that warp deploy/update skills append to at every milestone — a Linear-document-by-title primary with single-writer discipline, the agent's own durable store as second target and a local-file last resort, a machine-parseable per-chain row plus prose entry shape, and a surface-the-URL-as-proof hard gate. Referenced by any warp deploy/update skill that must leave a retrospective trail across worker restarts.
---

# Warp Run Log

Warp deploy/update runs are long, multi-milestone, and frequently interrupted (worker restart, session-restore, context compaction). The run log is the durable trail that lets a run be picked up after an interruption and lets each skill revision be tuned against what actually happened (floors vs actuals, timeouts, retries). Skills invoke this skill's contract instead of restating it, so the storage rules stay consistent everywhere.

## Why a dedicated skill

- Single source of truth for the storage target, single-writer rule, entry shape, and proof gate — these must be identical across every skill in the chain or a resumed run reads an inconsistent log.
- The contract had already been copy-pasted into two skills and was missing from the rest that do equally destructive, resumable work; centralizing it closes that drift and makes "add a run log to skill X" a one-line reference.

## Input (from the calling skill)

- **Calling skill name** — used verbatim in each prose entry's header (e.g. `warp-deploy-init-route`).
- **Milestone list** — the specific events this skill must log (the caller supplies its own "log at least" list; see each consumer).
- **Run key** — names the document. The ticket ID when the run has a ticket; otherwise the primary warp route ID. Skills that accept route-only invocations (send-test, nexus, validate-owners with explicit owners) use the route ID and are still bound by the same contract — a run without a ticket is not a run without a log. Whichever is used, it must be deterministic so a resumed run resolves the same document.

## Entry check — the calling skill's first action

Open-or-create the log before the skill's first real step. Never assume an earlier step created it — a chain can be entered part-way, or with earlier steps skipped. Idempotent: on a resumed run it finds the existing document and appends.

**Any per-run notes are the run log** — friction notes, scratch, debugging jottings. Write them into the primary as you go; never a side file to promote later.

## The storage contract

Every milestone must append an entry to a durable, per-run log — durable meaning it survives a worker restart / session restore. The worker's local filesystem (`~/.hyperlane/`) does NOT qualify on its own: it is ephemeral and vanishes on restore, which is the exact event the log exists to survive.

**Primary target — Linear document.** One document per run, titled exactly `<run-key> — run log`. Use whatever Linear tooling the current agent has (MCP integration, CLI script, direct API call, etc.) to:

- **Locate the document by exact title match.** Linear documents are not natively attachable to an issue in a way most list APIs filter on, so the title string IS the identity contract — treat it as canonical and do not fuzzy-match (two tickets must never collide).
- **If no document with that title exists, create one** with the exact title above.
- **Append entries as read-modify-write:** fetch the current body, append the new entry, save the concatenated body under the same document. See the single-writer note below — concurrent appends will silently drop entries.
- **Surface the document URL as proof (hard gate).** As soon as the document is created (or located on a resumed run), report its URL and exact title back to the operator through whatever channel this agent communicates on, and repeat the URL at skill exit. Claiming "run log updated" without ever surfacing a URL does NOT satisfy this requirement — an unshared log is unverifiable and counts as no log. A calling skill must not report itself complete until the document exists, carries its milestone entries, and its URL has been surfaced.

**Single-writer discipline.** Because the append is read-modify-write, two writers appending concurrently silently drop the earlier writer's entry (last-write-wins). Only one process may append to a given run log at any moment: if a subagent needs to record something, either it returns the entry to the parent to append serially, or the parent completes its append before spawning the subagent. Do NOT fan out logging to parallel workers against the same document.

**Second target — the agent's own durable store.** When Linear document tooling isn't available, use whatever append-capable storage this agent has that lives OUTSIDE the worker's filesystem — a persisted document store, notes store, or artifact store — keyed by the run key. Prefer one that appends in place over one that snapshots a whole file per write. Such stores are often scoped to the current conversation or thread: that survives a worker restart or a fresh worker resuming the same thread, but not a move to a new one, so pick the broadest scope offered. The identifier or URL still has to be surfaced per the hard gate above.

**Last resort — local file.** Only when neither of the above exists: write to `~/.hyperlane/run-logs/<run-key>.md` (create the file on the first entry). Flag the fallback explicitly in the first entry, and note that this file will not survive the worker being replaced; copy it into durable storage at each significant milestone so the retrospective still has data if the worker resets.

## Entry shape

Every entry has two parts:

1. **Machine-parseable rows** — one per chain the step touched, when the step deals with per-chain state. Pipe-delimited so the retrospective can grep floor-vs-actual diffs mechanically:

   ```
   chain | protocol | shape | floor | actual | verdict
   ```

   Format-only examples (values are illustrative — the actual chain, shape, and floor for a run come from the ticket, not from these rows; a route can have any combination of protocols and shapes):

   ```
   ethereum       | evm | collateral+RoutingFee | 0.008 ETH | 0.007 ETH | ✅ OK
   solanamainnet  | svm | crossCollateral+fee   | 6.5 SOL   | 0.3 SOL   | ⚠️  shortfall funded
   ```

   Use `pending` for the actual until it's known; append a post-hoc row once the actual is measured. Whatever shape / protocol / units the current route uses, keep the same six columns. Steps that touch no per-chain state may omit the rows and log prose only.

2. **Prose entry:**

   ```markdown
   ### <ISO-timestamp> — <calling-skill-name> — <step-label>

   - expected: <what the skill text predicted / requested>
   - actual: <what actually happened / observed output>
   - notes: <deviations, blockers, gas actuals vs floors, tx hashes, deployed addresses, retry counts, session-restore anomalies>
   ```

Do not skip entries when things go smoothly; success data grounds the retrospective as much as failure data. If any number, timing, or output diverges from what the calling skill's text predicts, log it — the diff is the input to the next skill revision.

## Consumers

`/warp-deploy-select-keys`, `/warp-deploy-validate-owners`, `/warp-deploy-fund-deployer`, `/warp-deploy-init-route`, `/warp-deploy-send-test`, `/warp-deploy-update-owners`, `/warp-deploy-register-route`, `/warp-deploy-nexus`, `/warp-update`, `/warp-update-resolve-artifacts`, `/warp-update-extend`, `/warp-update-propose`. Each keeps its own "Log at least" milestone list and passes its skill name into the prose header above.
