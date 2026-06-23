---
name: warp-update
description: Generic update orchestrator for an already-deployed warp route. Reads a Linear ticket describing any combination of warp-fee changes / ISM changes / hook changes / owner-address changes / additional-collateral-chain additions, edits the registry deploy.yaml accordingly, builds a per-chain strategy file from the artifact-context owner classifications, runs `hyperlane warp apply`, fork-simulates the resulting receipts via `/warp-route-check`, and hands off to `/warp-update-propose` to land the proposals. Chain extension (adding a brand-new chain with new on-chain contracts) is a separate skill — see `/warp-update-extend`.
---

# Warp Update — Generic Orchestrator

For UPDATES to an already-deployed warp route. Batches any combination of these change types in a single run:

- **Warp Fee Change** — `tokenFee.feeContracts.<chain>.bps`, fee `owner`, fee `maxFee` / `halfAmount`
- **ISM Change** — `<chain>.interchainSecurityModule`: switching ISM type (default fallback → aggregation → multisig), adding/removing modules from an aggregation, changing rate-limit caps, toggling pausable state, etc.
- **Hook Change** — `<chain>.hook`: switching hook type, adjusting amount-routing thresholds, swapping fallback hooks, etc.
- **Owner Change** — chain-level `owner`, fee-contract owner, ISM/hook owner, ProxyAdmin owner; any post-deploy ownership rotation
- **Additional Collateral Chain** — a new `<chain>` entry with `type: collateral` plus the corresponding extension of `tokenFee.feeContracts` (for multi-collateral routes)

For a brand-new warp route deployment use `/warp-deploy-init-route`. For adding a new chain that doesn't yet have any of the route's contracts on it use `/warp-update-extend` (it has the extra deploy-on-new-chain step this skill skips).

## Input

- **Linear ticket ID** (required, e.g. `AW-123`)
- **Warp route ID** (required, e.g. `ETH/arbitrum-base`)
- **Receipts directory** (optional) — where `warp apply` writes per-chain Safe TX Builder / AltVMFile receipts. Defaults to a tmp path derived from the ticket and warp route ID.

If the ticket ID or warp route ID is missing, ask the user.

### Prerequisite skills

This skill depends on three artifacts and three skill chains:

1. **`/warp-deploy-select-keys <ticket-id>`** must have produced `~/.hyperlane/key-contexts/<ticket-id>.yaml`. Required because `warp apply` may deploy new contracts during an update (new ISM, new hook, new fee contract on a chain that didn't have fees before, new router for an added collateral chain) and the deployer key signs those deploys via `jsonRpc` before any multisig sees a tx.
2. **`/warp-update-resolve-artifacts <ticket-id> <warp-route-id>`** must have produced `~/.hyperlane/update-context/<ticket-id>.yaml`. Required because the strategy file in Step 4 needs the per-artifact owner classification to dispatch each submission to the right submitter type.
3. **`/warp-deploy-fund-deployer <ticket-id>`** must have run successfully in Step 5 below. Required because the deployer's address needs sufficient balance on every chain that may see new deploys.

If any of those artifacts is missing when this skill starts, invoke the corresponding skill first.

---

## Step 1: Read the Linear Ticket and Identify Requested Changes

Use the Linear MCP `get_issue` tool to fetch the ticket. Parse the description for change instructions. Common targets:

| Ticket language                                                       | deploy.yaml target                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| "Update warp fee on `<chain>` to N bps" / fee-direction changes       | `tokenFee.feeContracts.<chain>.bps` (on the synthetic chain's tokenFee)                  |
| "Change fee owner to `<addr>`"                                        | `tokenFee.feeContracts.<chain>.owner` (per-chain) or `tokenFee.owner` (RoutingFee-level) |
| "Change ISM to / add module / remove module / pause / set rate limit" | `<chain>.interchainSecurityModule` — flat address or nested object; see Step 1a          |
| "Change hook to / set threshold / swap fallback"                      | `<chain>.hook` — flat address or nested object; see Step 1a                              |
| "Rotate chain owner on `<chain>` to `<addr>`"                         | `<chain>.owner`                                                                          |
| "Rotate ProxyAdmin owner on `<chain>` to `<addr>`"                    | `<chain>.proxyAdmin.owner`                                                               |
| "Add `<chain>` as additional collateral"                              | new `<chain>:` entry with `type: collateral` + `tokenFee.feeContracts.<chain>: { … }`    |

If the ticket combines multiple changes, parse them all. The skill applies the batched edits in a single `warp apply` run.

### 1a: ISM and Hook Targeting (flat vs nested)

`interchainSecurityModule` and `hook` can each be either a flat string address (for "use mailbox default" or an existing custom contract) OR a nested object describing the on-chain structure. Common nested shapes:

- `staticAggregationIsm` with `modules: [...]` (each module potentially a `rateLimitedIsm`, `pausableIsm`, `defaultFallbackRoutingIsm`, etc.)
- `amountRoutingHook` with `domains: { <chain>: <inner-hook> }`, `lowerHook`, `upperHook`, `threshold`
- Routing variants (`domainRoutingIsm`, `fallbackRoutingHook`) with `domains: { <chainName>: <inner> }`

For the target field, **read the current deploy.yaml first (Step 2) and identify the actual on-chain shape**. Then edit the specific node — e.g. for "set rate limit on solanamainnet to 200M", find the `rateLimitedIsm` node inside the aggregation tree on solanamainnet and update its `maxCapacity` field. Don't guess the structure — verify against the current state.

The same logic applies to hook updates: find the relevant node (lower/upper hook, a specific domain's routing entry, a fallback hook) and update it surgically. See the nested-tree walk pattern documented in `/warp-update-resolve-artifacts` Step 3.

**Before committing to a new ISM or hook structure, research the semantics yourself.** It is **extremely easy** to brick a warp route by misconfiguring an ISM or a hook — a deploy.yaml typo that survives `warp apply` and lands on chain costs everyone hours of recovery. The skill intentionally does not enumerate every safe composition; the right shape depends on what the ticket wants. Do the work:

For any new ISM module or hook component you are about to add, remove, or recompose:

1. **Read the source.** `solidity/contracts/isms/<Name>.sol` or `solidity/contracts/hooks/<Name>.sol`. Walk `verify()` (ISM) or `postDispatch()` / `quoteDispatch()` (hook) line-by-line under the new config.
2. **Trace both paths.** Normal path: is the security / cost / gas-payment guarantee you expect actually enforced? Emergency path (paused, rate-limited, threshold crossed): is the failure mode what the ticket wants (revert / reroute / drop)?
3. **Aggregation math.** `staticAggregationIsm` with `threshold = modules.length` is AND across modules; `threshold: 1` is OR. Pick deliberately and confirm it matches the ticket's intent.
4. **Preserve removed guarantees.** Replacing `0x0` (mailbox default) means removing whatever the mailbox default was enforcing — validator set, IGP gas payment, merkle-tree insertion. Compose so the guarantee survives — commonly via `defaultFallbackRoutingIsm` inside aggregation for ISMs, or `aggregationHook` / `fallbackRoutingHook` retaining the default hook for hooks.

Brick modes to specifically check against (non-exhaustive — there are more):

- **No-op ISM standalone.** Some ISMs (e.g. `pausableIsm`) have `verify()` that returns `true` unconditionally when their gate is open — they do no actual verification. Used alone, every message delivers. They MUST be composed with a real verifying ISM via aggregation.
- **Always-reverting ISM standalone.** Some ISMs have preconditions (e.g. `rateLimitedIsm` requires the message to already be `_isDelivered`) that are false during normal verify-time. Used alone, no message can be delivered.
- **Threshold-1 with a guard module.** `staticAggregationIsm({ pausableIsm, defaultFallbackRoutingIsm }, threshold: 1)` is broken — the pause never gates anything because the default still passes. Threshold must equal the count of modules you want to AND together.
- **Hook that swallows IGP payment.** Replacing the mailbox-default hook (which typically includes the InterchainGasPaymaster) with a single-purpose hook means gas is not paid and the relayer never picks up the message. Compose new hooks via `aggregationHook` / `fallbackRoutingHook` so IGP payment stays on the success path.
- **Amount-routing threshold misconfigured.** `amountRoutingHook` with an unrealistic `threshold` silently misroutes every dispatch (too high → all transfers go to `upperHook`; too low → all go to `lowerHook`).

When uncertain about a composition you have not used before, surface the question to the user with the relevant contract excerpt rather than guessing.

**Canonical schema files — read these when authoring or editing nested ISM / hook / fee configs:**

- ISMs: `typescript/sdk/src/ism/types.ts` — `IsmConfigSchema` union, plus per-type schemas (`PausableIsmConfigSchema`, `RateLimitedIsmConfigSchema`, `AggregationIsmConfigSchema`, `RoutingIsmConfigSchema`, etc.). The `MUTABLE_ISM_TYPE` constant enumerates which types can be edited in place vs. which require a fresh deploy on any change.
- Hooks: `typescript/sdk/src/hook/types.ts` — `HookConfigSchema` union, plus per-type schemas. `MUTABLE_HOOK_TYPE` is the equivalent in-place-editable list.
- Fees: `typescript/sdk/src/fee/types.ts` — `TokenFeeConfigSchema` discriminated union (`LinearFee`, `RoutingFee`, `CrossCollateralRoutingFee`, etc.); note that `LinearFee.bps` is immutable so `bps` edits trigger a redeploy.
- Top-level token / per-chain router shape: `typescript/sdk/src/token/types.ts` — `HypTokenRouterConfigSchema` and the `HypTokenConfig` token-type union.
- Shared mixins: `typescript/sdk/src/types.ts` — `OwnableSchema` (`owner` + optional `ownerOverrides`) and `PausableSchema` (Ownable + `paused: boolean`). Many ISM / hook configs `.extend(OwnableSchema)` or `.and(PausableSchema)`, so `owner` is required on more types than the field name alone would suggest (every routing-variant ISM, the offchain-lookup ISM, the interchainAccountRouting ISM, the rate-limited ISM optionally, pausableIsm, etc.).

Reference existing production deploy.yamls using the same composition — grep `deployments/warp_routes/*/*-deploy.yaml` in the registry for the pattern you want. Copy the canonical shape; missing required fields (e.g. `owner` or `domains: {}` on `defaultFallbackRoutingIsm`, `paused: false` on `pausableIsm`) get rejected at Zod parse time by `warp apply`, but the resulting error spam is voluminous — starting from a known-good shape is faster.

### 1b: Show the Parsed Changes to the User

Surface the requested-changes summary as a table:

```
Ticket AW-123 requests:
  - <chain> / tokenFee.feeContracts.<chain>.bps : 5 → 10
  - <chain> / interchainSecurityModule.modules[1].maxCapacity (rateLimitedIsm) : 5e24 → 2e25
  - <chain> / owner : 0xABC… → 0xDEF…
```

Ask the user to correct anything wrong before proceeding. No `[CONFIRM:]` here — this is information gathering, not destructive.

---

## Step 2: Fetch Current deploy.yaml

```bash
REGISTRY_PATH="${HYPERLANE_REGISTRY:-$(pwd)/../hyperlane-registry}"
cat $REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-deploy.yaml
```

Show the user the current content. This is the baseline the warp-apply diff is computed against.

---

## Step 3: Apply Edits to deploy.yaml

For each requested change from Step 1, target the precise field. Parse the YAML, mutate the target, serialize back. Do NOT do a global string replace — that's how field-targeting bugs sneak in.

Preserve the existing YAML formatting (alphabetical chain order at the top level AND alphabetical keys within each chain entry, per the rule in `/warp-deploy-init-route` Step 4). The registry CI / CodeRabbit enforces both invariants.

Show the user the diff (unified format, `-` old, `+` new). End your message with:

```test
[CONFIRM: Apply deploy.yaml edits for <ticket-id>]
```

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

If confirmed, write the updated deploy.yaml back to the registry.

---

## Step 4: Build the Strategy File

The strategy file tells `warp apply` how to submit each chain's transactions. For each chain in the route, look up the artifact owners from the auto-loaded artifact context (`~/.hyperlane/update-context/<ticket-id>.yaml`) and map the owner type to the right submitter:

| Owner type from artifact context                                      | Strategy submitter                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Safe`                                                                | `gnosisSafeTxBuilder` with that chain's Safe address                                                                                                                          |
| `ICA`                                                                 | `interchainAccount` with `origin: <controllingChain>`, `internalSubmitter: gnosisSafeTxBuilder` targeting the controlling Safe                                                |
| `Squads`                                                              | `file` (no native Squads submitter in `warp apply`; the propose skill calls `submitProposalToSquads` against the file later)                                                  |
| `EOA`                                                                 | `jsonRpc` if it's the deployer key signing post-deploy ops; otherwise halt — EOAs should have been caught at `/warp-deploy-validate-owners` and rejected as production owners |
| `Turnkey` / `Privy` / `MPC` / `CustomMultisig` / `Timelock` / `Other` | `file` (manual hand-off to the relevant tooling)                                                                                                                              |
| `Unknown`                                                             | Halt — can't dispatch without an owner classification                                                                                                                         |

If different artifacts on the same chain have different owners (router → AW Safe vs. fee contracts → Foundation Safe is the common case), the strategy needs a `feeSubmitter` block in addition to the main `submitter` block — see `/warp-update-extend` Step 7's "fee contract with a separate fee Safe" pattern.

Write the strategy file to `~/.hyperlane/strategies/<ticket-id>-strategy.yaml`. Show the user the strategy + end with:

```test
[CONFIRM: Proceed with this strategy file]
```

---

## Step 5: Pre-flight — Deployer Balance Check

`warp apply` may deploy new contracts mid-update — a new ISM if you switch from default to custom (or aggregation → multisig), a new hook if you swap rate-limiting in or out, a new fee contract on a chain that didn't have fees before, a new router for an added collateral chain. The deployer signs those deploys via `jsonRpc` before any multisig sees a tx.

Invoke `/warp-deploy-fund-deployer <ticket-id>`. The skill checks per-chain balances against the warp-deploy gas budget and auto-tops-up shortfalls from the Hyperlane treasury via `fund-wallet-from-deployer-key.ts`.

If `/warp-deploy-fund-deployer` reports any chain it couldn't auto-fund (treasury empty, chain unsupported by the funding script), halt and surface to the user — they'll need to top up manually before warp apply runs.

---

## Step 6: Start the HTTP Registry + Run `warp apply`

### 6a: Start the HTTP Registry

The HTTP registry must be running before warp apply so the deploy uses private RPCs (avoids stale-gas / OOG issues with public free-tier endpoints):

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry --writeMode
```

Run with `run_in_background: true`. Wait for the log line `Server running`. Note the port (typically `3333`) and the background task ID.

### 6b: Build and Run the Warp Apply Command

Use the key-context artifact to resolve per-protocol key values (see the key-value expansion legend in `/warp-deploy-validate-owners`):

```bash
pnpm --silent -C typescript/cli hyperlane warp apply \
  --registry http://localhost:<port> \
  --key.ethereum <KEY_ETHEREUM_VALUE> \
  [--key.sealevel <KEY_SEALEVEL_VALUE>] \
  [--key.cosmos <KEY_COSMOS_VALUE>] \
  --strategy ~/.hyperlane/strategies/<ticket-id>-strategy.yaml \
  --receipts-dir <receipts-dir> \
  -w <WARP_ROUTE_ID> \
  --yes
```

Show the user the command (with secret NAMES from the artifact, never raw key values) + end with:

```test
[CONFIRM: Run warp apply for <warp-route-id>]
```

After approval, run it. Show the full output.

**On success**: warp apply writes per-chain receipts files to `<receipts-dir>`:

- `combined-chainId<id>-safe<addr8>-<ts>-receipts.json` per Safe (gnosisSafeTxBuilder submitter)
- `<chain>-file-<ts>-receipts.json` per SVM chain or other file-submitter chain (AltVMFileSubmitter)
- Plus `<chain>-jsonRpc-<ts>-receipts.json` for any deployer-signed deploys that already executed

**On failure**: halt, surface the error, stop the HTTP registry (Step 10). Common issues:

- Deployer key not funded → re-run Step 5
- Strategy chain not in deploy.yaml → verify all chains in the strategy match the deploy.yaml
- ICA owner mismatch → re-run `/warp-update-resolve-artifacts` and confirm the resolved owners match what the deploy.yaml expects

---

## Step 7: Defensive `transferOwnership` Check

`warp apply` has historically had a bug (now fixed in monorepo) where `runWarpRouteApply` set ALL chain owners to the deployer in its internal `intermediateOwnerConfig` and wrote that back, producing unexpected `transferOwnership(deployer)` proposals for existing chains. The defensive check remains as scar tissue for users on older CLI versions.

```bash
grep -r "transferOwnership" <receipts-dir>/
```

Expected results:

- `transferOwnership(<new-owner>)` on artifacts whose owner is CHANGING per the ticket → expected
- `transferOwnership(<customer-ICA-or-Safe>)` on a newly-deployed contract (new ISM, new fee contract, new router for an added collateral chain) → expected; deployer atomically transfers ownership to the configured owner in the same warp apply run
- ANY OTHER `transferOwnership` call → corruption signal. Halt, do not proceed to propose. Restore correct owners in deploy.yaml from git history, re-run warp apply.

---

## Step 8: Fork-Simulate-Verify Gate (mandatory)

This is a HARD gate before any propose call lands on chain. The flow: fork every chain in the route via `hyperlane warp fork`, replay the warp apply receipts under impersonated owners, self-relay any cross-chain ICA messages, and run `hyperlane warp check` on the fork to confirm the on-chain state matches the target deploy.yaml.

Invoke:

```
/warp-route-check
```

Pass the warp route ID + the receipts directory. The skill returns PASS / FAIL with a per-chain violation table.

- **PASS**: proceed to Step 9.
- **FAIL**: surface the violations. Do NOT proceed to propose. Two options:
  - The deploy.yaml diff is wrong → go back to Step 3, fix, re-apply.
  - The warp apply output is corrupt (transferOwnership-to-deployer bug, etc.) → see Step 7.

Skipping this gate has caused production incidents in the past — the rule is non-negotiable.

---

## Step 9: Hand Off to `/warp-update-propose`

If the fork-simulate-verify passes:

```
/warp-update-propose <ticket-id> <receipts-dir>
```

The propose skill posts all batches to Safe Transaction Service (EVM) and Squads (SVM), persists a summary at `~/.hyperlane/proposals/<ticket-id>.yaml`, and points the human at Heimdall / Squads UI / customer Safe app per governance context.

---

## Step 10: Stop the HTTP Registry

Use `TaskStop` with the background task ID from Step 6a. If that doesn't clean up the underlying process on minimal-tool sandboxes (no `ps`/`lsof`/`pkill`/`fuser`), use the `/proc` cmdline-scan fallback documented in `/warp-deploy-init-route`. Always stop the registry — even on failure paths — so no background process is left running.

---

## Notes

- **Scope**: this skill handles ONLY existing-route updates. For brand-new deployments use `/warp-deploy-init-route`. For chain extensions (adding a new chain with new on-chain contracts) use `/warp-update-extend`. The dispatch is at the user level — there's no auto-detection of which skill applies.
- **Batching**: multiple changes in one ticket are applied to the same deploy.yaml diff and proposed in a single warp apply run. Signers get one batch per Safe / governance context rather than N small batches per individual change.
- **The strategy file is the dispatch layer**. Owner-type → submitter mapping (Step 4) is the single point that controls whether a chain's batch goes through Heimdall (via Safe Transaction Service, for AW/Foundation Safes), Squads (file submitter + `submitProposalToSquads` in the propose skill), or manual hand-off (file submitter for Turnkey / Privy / customer multisigs).
- **Fork-simulate-verify is mandatory**, not optional. The gate at Step 8 catches deploy.yaml drift, runWarpRouteApply corruption, ICA mis-derivation, and ISM/hook misconfiguration before signers see anything.
- **`warp apply` can deploy new contracts** for any update type — not just collateral additions. ISM/hook changes that introduce new module types trigger new-contract deploys; fee changes on a chain that previously had no fees trigger a new fee contract; etc. The funding preflight at Step 5 matters across all update types for this reason.
- **No customer Safe automation**. For customer-owned routes (governance type `Regular` per the artifact context), the strategy still uses `gnosisSafeTxBuilder` because the propose skill knows how to dispatch to a customer's Safe via Safe Transaction Service. But the executioner step (signing + executing) happens in the customer's Safe app, not Heimdall.
