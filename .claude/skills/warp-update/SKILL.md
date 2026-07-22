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

## Run Log (mandatory)

Maintain the durable, per-ticket run log per `/warp-run-log` — that skill owns the storage contract (Linear-document-by-title primary, single-writer discipline, local-file fallback), the machine-row + prose entry shape, and the surface-the-URL-as-proof hard gate. Use `warp-update` as the skill name in each prose entry, and do not report this skill complete until the run-log URL has been surfaced.

**Log at least:** (a) skill entry with the ticket ID + warp route ID + the change types detected, (b) every `[CONFIRM:]` gate — before and after the response, (c) the surgical deploy.yaml edits made, (d) the `warp apply` run (any newly deployed contract addresses + tx/receipt refs), (e) the fork-simulate-verify verdict from `/warp-route-check`, (f) the propose handoff (batch → signer per `/warp-update-propose`), (g) the registry PR URL, (h) skill exit (success or bail-out). Log smooth steps too — success data grounds the retrospective as much as failure data.

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

Fetch the ticket per `/fetch-linear-ticket`. Parse the returned description for change instructions. Common targets:

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

### 1c: xERC20 routes — token ownership is NOT a `warp apply` change

On an xERC20 / xERC20-lockbox route, the warp config's `owner` is the **router** owner. `warp apply` manages the router / ISM / hook / rate-limit config only — it does **not** transfer the underlying xERC20 token's ownership or its ProxyAdmin. Those are a separate contract (`xerc20:token` / `xerc20:proxyAdmin` — see `/warp-update-resolve-artifacts`) and move via **`hyperlane xerc20 apply`**, which is config-driven and submitted through the same strategy/submitter machinery (a Safe / ICA / timelock owner all work — do NOT route xERC20 ownership through the infra check-deploy path). In that command's config the top-level `owner` is the **token** owner, and the ProxyAdmin owner resolves as `ownerOverrides.proxyAdmin ?? proxyAdmin.owner ?? owner` (unspecified → token and ProxyAdmin both go to `owner`). Never conflate the two `owner` meanings: it is the router owner under `warp apply`, the token owner under `xerc20 apply`. The token may also be externally governed or non-`Ownable` (per `/warp-update-resolve-artifacts`), in which case we can't transfer it — surface that instead of emitting a doomed `transferOwnership`.

If a run changes both xERC20 bridge limits (`setBufferCap` / `addBridge` / `setRateLimitPerSecond`) AND token ownership, sequence **limits/bridges first, ownership handoff last** — both are `onlyOwner`, so once ownership moves to a Safe/timelock the deployer can no longer set limits.

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

## Step 2: Detect the Source of Truth (YAML or Config Getter)

Warp routes come in two flavors in this monorepo, and the edit path branches on which one:

- **Plain YAML route** — the `deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml` in the registry IS the source of truth. Edit it directly.
- **Config-getter route** — the source of truth is a TypeScript getter in `typescript/infra/config/environments/<env>/warp/configGetters/`, registered in `warpConfigGetterMap` in `typescript/infra/config/warp.ts`. The registry's `deploy.yaml` is GENERATED from the getter via `typescript/infra/scripts/warp-routes/export-warp-configs.ts`. Editing the registry YAML directly will be silently overwritten the next time the export script runs.

Determine which kind the route is by checking the map:

```bash
grep -E "^\s*'?<WARP_ROUTE_ID>'?:" typescript/infra/config/warp.ts
```

If the route ID is keyed in `warpConfigGetterMap` (or in the per-environment dispatch in that file), it's a **getter-backed route**. Note which getter file it points to (e.g. `getRenzoPZETHWarpConfig.ts`). If the route ID isn't in the map at all, it's a **plain YAML route**.

Then fetch the CURRENT state (regardless of source flavor):

```bash
REGISTRY_PATH="${HYPERLANE_REGISTRY:-$(pwd)/../hyperlane-registry}"
cat $REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-deploy.yaml
```

Show the user the current YAML content + the flavor (YAML / getter-backed + which getter file). This is the baseline the warp-apply diff is computed against either way; the difference shows up in Step 3 (where the edit lands).

---

## Step 3: Apply Edits

For each requested change from Step 1, target the precise field. Parse the YAML, mutate the target, serialize back. Do NOT do a global string replace — that's how field-targeting bugs sneak in.

Preserve the existing YAML formatting (alphabetical chain order at the top level AND alphabetical keys within each chain entry, per `/registry-yaml-sort-policy`). The registry CI / CodeRabbit enforces both invariants.

### 3a: Plain YAML Route — Edit the Registry File Directly

If Step 2 classified the route as plain YAML, edit `$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml` in place. Show the user the diff (unified format, `-` old, `+` new). End your message with:

```test
[CONFIRM: Apply deploy.yaml edits for <ticket-id>]
```

If confirmed, write the updated deploy.yaml back to the registry.

### 3b: Config-Getter Route — Edit the Getter, Then Regenerate

If Step 2 classified the route as getter-backed:

1. **Edit the getter TS file** in `typescript/infra/config/environments/<env>/warp/configGetters/<getter>.ts` to encode the requested changes. The getter returns a `ChainMap<HypTokenRouterConfig>`; mutate the relevant fields in the returned object. Show the user the unified TS diff.

2. **Regenerate the registry YAML** by running the export script for ONLY this route:

   ```bash
   pnpm -C typescript/infra tsx scripts/warp-routes/export-warp-configs.ts \
     -e <env> \
     --warpRouteIds <WARP_ROUTE_ID>
   ```

   This calls the getter, sorts the output per `WARP_YAML_SORT_CONFIG`, and writes `$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml` in place.

3. **Diff the regenerated YAML against the previous version** (e.g. `git -C $REGISTRY_PATH diff deployments/warp_routes/<TOKEN>/`). The diff should match the conceptual change requested in the ticket; if other fields drifted, the getter has a bug or the export script picked up unrelated env state. Halt and surface the unexpected diff to the user before continuing.

End your message with:

```test
[CONFIRM: Apply getter edits + regenerated deploy.yaml for <ticket-id>]
```

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

For getter-backed routes, **both** changes ship as PRs in Step 11:

- Monorepo PR for the getter edit (no changeset needed — `@hyperlane-xyz/infra` is `private: true`).
- Registry PR for the regenerated YAML + changeset (per the standard Step 11 flow).

Step 11 covers the registry PR; for the monorepo PR open it separately with a normal `gh pr create` against `main`, scoping `git add` to the specific getter file + `typescript/infra/config/warp.ts` if you touched the map.

---

## Step 4: Build the Strategy File

### 4a: Map Owner Types to Submitters

The strategy file tells `warp apply` how to submit each chain's transactions. For each chain in the route, look up the artifact owners from the auto-loaded artifact context (`~/.hyperlane/update-context/<ticket-id>.yaml`) and map the owner type — AND the controller type of any wrapping account — to the right submitter:

| Owner type from artifact context                                      | Strategy submitter                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Safe`                                                                | `gnosisSafeTxBuilder` with that chain's Safe address                                                                                                                                                                                        |
| `ICA` (controller = Safe)                                             | `interchainAccount` with `origin: <controllingChain>`, `owner: <controllerAddress>`, `internalSubmitter: gnosisSafeTxBuilder` targeting the controlling Safe                                                                                |
| `ICA` (controller = EOA)                                              | `interchainAccount` with `origin: <controllingChain>`, `owner: <controllerEOAaddress>`, `internalSubmitter: file` (write the `callRemote` for the EOA to broadcast later) or `internalSubmitter: jsonRpc` (execute live with the EOA's key) |
| `Squads`                                                              | `file` (no native Squads submitter in `warp apply`; the propose skill calls `submitProposalToSquads` against the file later)                                                                                                                |
| `EOA`                                                                 | `jsonRpc` if it's the deployer key signing post-deploy ops; otherwise halt — EOAs should have been caught at `/warp-deploy-validate-owners` and rejected as production owners                                                               |
| `Turnkey` / `Privy` / `MPC` / `CustomMultisig` / `Timelock` / `Other` | `file` (manual hand-off to the relevant tooling)                                                                                                                                                                                            |
| `Unknown`                                                             | Halt — can't dispatch without an owner classification                                                                                                                                                                                       |

**The ICA branch has two sub-cases, not one.** Don't unconsciously default to `internalSubmitter: gnosisSafeTxBuilder` just because most production ICAs are Safe-controlled. Read the controller type from the artifact context (`/warp-update-resolve-artifacts` Step 3 walks each ICA's `InterchainAccountRouter` to resolve the controller and classifies it). If the controller is an EOA, the Safe-builder path will silently produce nonsensical output that no Safe app can consume — pick `file` or `jsonRpc` instead.

If different artifacts on the same chain have different owners (router → AW Safe vs. fee contracts → Foundation Safe is the common case), the strategy needs a `feeSubmitter` block in addition to the main `submitter` block — see `/warp-update-extend` Step 7's "fee contract with a separate fee Safe" pattern.

Write the strategy file to `~/.hyperlane/strategies/<ticket-id>-strategy.yaml`. Show the user the strategy.

### 4b: Preview Expected Output Files Before Confirming

Before the user confirms the strategy, **describe what `warp apply` will write to the receipts directory** — per chain, per submitter type. This is the structural guardrail: catching a wrong-strategy-shape (raw owner-ops vs. ICA-wrapped, Safe-builder JSON vs. SVM versioned-tx array) BEFORE the apply phase deploys mainnet contracts means the user can reject the strategy here, not after seeing wrong-format files post-deploy.

For each chain entry in the strategy, surface:

1. Expected filename pattern in the receipts directory
2. The shape of the JSON / file body
3. Who downstream consumes that file (so the user can sanity-check the strategy serves the intended consumer)

| Submitter chosen in 4a                                         | Filename pattern                                                                         | File body shape                                                                                                                                                                                                                                                                                                                                                | Downstream consumer                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `jsonRpc`                                                      | `<chain>-jsonRpc-<ts>-receipts.json`                                                     | Already-broadcast tx receipts (`status`, `gasUsed`, `logs`, etc.). One entry per submitted tx. Real on-chain action happened during apply.                                                                                                                                                                                                                     | No proposer step — done.                                                                                                                   |
| `impersonatedAccount`                                          | `<chain>-impersonatedAccount-<ts>-receipts.json`                                         | Same shape as `jsonRpc` receipts but executed against the anvil fork via `anvil_impersonateAccount`. Fork-test artifact only.                                                                                                                                                                                                                                  | No proposer step — fork test.                                                                                                              |
| `gnosisSafeTxBuilder`                                          | `combined-chainId<id>-safe<addr8>-<ts>-receipts.json`                                    | Safe Transaction Service multisend bundle: `{ chainId, safe, transactions: [{ to, value, data }, ...] }`. Multiple ops batched into one Safe tx.                                                                                                                                                                                                               | `safes/propose-warp-batch.ts` → Safe TX Service → Safe app for signing                                                                     |
| `interchainAccount` + `internalSubmitter: gnosisSafeTxBuilder` | `combined-chainId<originId>-safe<originSafe8>-<ts>-receipts.json`                        | Safe-builder bundle on the ORIGIN chain (not the destination). `transactions[].to = originChain's InterchainAccountRouter`; `transactions[].data` is an encoded `callRemote(...)`. The destination-chain owner-op (setIsm, setFeeContract, etc.) is the calldata embedded inside the `callRemote` payload, not a top-level entry.                              | `safes/propose-warp-batch.ts` → origin chain's Safe → relayer dispatches one Hyperlane message per `callRemote` → destination ICA executes |
| `interchainAccount` + `internalSubmitter: file`                | `<chain>-ica-callremote-<ts>.json` (filename comes from the file submitter's `filepath`) | Plain JSON array: `[{ to: <originICARouter>, from: <ICAOwnerAddress>, value: <IGPQuote-wei>, data: <encoded callRemote> }]`. **One entry per file** (one `callRemote` per destination). `from` MUST equal the configured ICA owner — `callRemote` derives the ICA from `msg.sender`, so broadcasting from a different account routes to the wrong (empty) ICA. | Human / external tool broadcasts the tx from the configured `from` address                                                                 |
| `interchainAccount` + `internalSubmitter: jsonRpc`             | `<chain>-jsonRpc-<ts>-receipts.json`                                                     | Executed `callRemote` tx receipts. Real origin-chain broadcast happened during apply; relayer picks up the message and the destination ICA executes asynchronously.                                                                                                                                                                                            | No proposer step — destination call happens via Hyperlane relayer (watch destination chain explorer)                                       |
| `file` (top-level, no ICA wrapper)                             | `<chain>-file-<ts>-receipts.json`                                                        | Array of `PrintableSvmTransaction` objects: `[{ transaction_base58: <v0-versioned-tx>, ... }]`. Used for SVM chains (Sealevel) where the propose path is Squads.                                                                                                                                                                                               | `squads/propose-warp-batch.ts` → Squads proposer                                                                                           |

For each chain in the strategy, print a sentence like:

> _"`base` will produce `~/.hyperlane/receipts/<ticket-id>/base-ica-callremote-<ts>.json` — one `callRemote` tx to ethereum's InterchainAccountRouter, with `from = 0x3f13…0913` (configured ICA owner) and `data` encoding the destination-side `setFeeContract(arbitrumDomain, <new-linear-fee>)`. Downstream: you'll broadcast this tx from `0x3f13…0913`'s EOA."_

If the previewed shape doesn't match what the user is expecting (e.g. they expected a Safe-builder bundle but the preview describes an ICA `callRemote`, or vice versa), halt — the strategy in 4a is wrong. Re-derive.

End with:

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

Invoke `/start-http-registry` with `--writeMode` so newly-deployed contract addresses (new ISM / hook / fee contract / router) get persisted back through the server. The HTTP registry's serving of private/pinned RPCs is what avoids stale-gas / OOG issues + confirmation-poll timeouts against public free-tier endpoints — this benefit is from the server itself, independent of `--writeMode` (writeMode just enables the write routes).

After a writeMode-enabled run, before committing anything from the registry checkout: scope `git add` to ONLY the warp route config files (`deployments/warp_routes/<TOKEN>/...`). Do not stage chain-metadata files; if a private/API-keyed RPC override was supplied at runtime, it could have landed in a write-route mutation, and an unscoped commit would publish the API key.

### 6a-check: Resuming after a failed / interrupted / wiped run (idempotency)

`warp apply` deploys new contracts during an update — a bps change forces a `LinearFee` redeploy (bps is immutable), and a new ISM / hook / router deploys fresh too. Those deploys are **irreversible mainnet gas**, and on-chain deploys survive a worker/session wipe while the local registry edits, strategy file, and branch state do NOT. So a blind re-run after an interruption redeploys a fresh set and **orphans the previous one** (unrecoverable).

Before (re-)running apply where a prior attempt may already have deployed:

1. Check the run log (`/warp-run-log`) — the prior run records each newly-deployed address as a milestone. Cross-check against on-chain state (`warp read`) to see whether the target contracts (the new `LinearFee`, the composed ISM/hook stack, a new router) already exist and match the intended config.
2. If a matching set already exists, **reuse it** — wire those addresses into the deploy.yaml instead of letting apply redeploy. Redeploying orphans the earlier contracts and can leave the route pointing at the wrong set.
3. The moment the deploy phase of apply completes, record every deployed address to the run log immediately — before any further step — so a mid-run wipe doesn't force a blind redeploy next time.

The fork-simulate-verify gate (Step 8) runs before any propose, but the _deploy_ inside apply is the irreversible step, so this idempotency check is what prevents duplicate mainnet deploys.

### 6b: Build and Run the Warp Apply Command

Use the key-context artifact to resolve per-protocol key values (see the canonical key-value expansion legend in `/warp-key-value-expansion`):

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

Stop the registry per `/stop-http-registry` (using the background task ID from Step 6a). Always stop it — even on failure paths — so no background process is left running.

---

## Step 11: Open Registry PR with Target Config

The deploy.yaml in `$REGISTRY_PATH` already reflects the **target post-update state** (set in Step 3). Open a PR now — you do NOT have to wait for the multisig proposals from Step 9 to be signed + executed. The registry's `check-warp-deploy.yaml` GitHub Action runs on every PR push: it determines which warp route IDs were changed (added / renamed / modified `*-config.yaml` or `*-deploy.yaml`) and runs `hyperlane warp check` against the on-chain state, posting a sync table as a PR comment. So the PR can be opened immediately and merged once the CI's sync check goes green (which happens after signers execute the proposals — sometimes hours or days later).

### 11a: Write the Changeset

Invoke `/add-registry-changeset` with:

- Change summary: a one-sentence past-tense description matching the Linear ticket scope (e.g. `reduced base→arbitrum fee to 11 bps and added pausable hook on base for ETH`)
- Bump: `patch` (updating an existing route — not a new published asset)
- Filename slug: `update-<token>-<chains>-<short-change>` (e.g. `update-eth-arbitrum-base-fee-and-pause-hook`)

### 11b: Scoped Commit + PR

```bash
cd $REGISTRY_PATH
git checkout -b update/<token>-<chains>-<ticket-id>

# Stage ONLY the changed warp-route config + the changeset. NEVER `git add .` /
# `git add -A` here — unrelated FS writes from the HTTP registry's writeMode
# could carry API-keyed RPC overrides that would leak on commit.
git add deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml
git add .changeset/<slug>.md
git status   # Verify nothing else is staged

git commit -m "chore(<warp-route-id>): <short summary>"
git push -u origin HEAD

gh pr create \
  --base main \
  --title "chore(<warp-route-id>): <short summary>" \
  --body "$(cat <<'EOF'
## Summary

Updates the `<WARP_ROUTE_ID>` warp route's target `deploy.yaml` per `<ticket-id>`. The on-chain wiring lands via the proposals dispatched in `/warp-update-propose`; the `check-warp-deploy` CI on this PR will go green once signers execute them.

| Field | Value |
| ----- | ----- |
| **Linear** | <linear-issue-url> |
| **Changes** | <bulleted summary of the diff vs prior config> |
| **Proposal references** | <Safe TX hashes / Squads sigs from the Step 9 summary> |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Surface the PR URL to the user. Once CI goes green (typically after the last multisig proposal executes) the PR is mergeable.

### 11c: Companion Monorepo PR (config-getter routes only)

If Step 2 classified the route as **getter-backed** and Step 3b edited a TS getter, also open a monorepo PR for the getter change. The registry YAML PR above carries the _regenerated_ artifact; this PR carries the _source_ of that regeneration. Both must land for the route's config-getter loop to stay consistent.

```bash
cd <MONOREPO_ROOT>
git checkout -b update/<token>-<chains>-<ticket-id>

# Scope: the getter file (and warp.ts if you touched the map). Nothing else.
git add typescript/infra/config/environments/<env>/warp/configGetters/<getter>.ts
# only if the warpConfigGetterMap was modified:
# git add typescript/infra/config/warp.ts
git status   # Verify nothing else is staged

git commit -m "feat(infra): <short summary of getter change>"
git push -u origin HEAD

gh pr create \
  --base main \
  --title "feat(infra): <short summary>" \
  --body "$(cat <<'EOF'
## Summary

Updates the `<WARP_ROUTE_ID>` config getter per `<ticket-id>`. The companion registry PR with the regenerated `deploy.yaml` is at `<registry-pr-url>`.

| Field | Value |
| ----- | ----- |
| **Linear** | <linear-issue-url> |
| **Registry PR** | <registry-pr-url> |
| **Changes** | <bulleted summary of the getter diff> |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

No changeset needed (`@hyperlane-xyz/infra` is `"private": true` and isn't published). Surface this PR URL to the user too.

---

## Notes

- **Scope**: this skill handles ONLY existing-route updates. For brand-new deployments use `/warp-deploy-init-route`. For chain extensions (adding a new chain with new on-chain contracts) use `/warp-update-extend`. The dispatch is at the user level — there's no auto-detection of which skill applies.
- **Source-of-truth flavors**: Step 2 detects whether the route's config lives as a plain registry YAML or as a TypeScript getter in `typescript/infra/config/environments/<env>/warp/configGetters/`. Steps 3a vs 3b branch on this; Step 11 always produces a registry PR with the regenerated/edited YAML, and Step 11c additionally opens a monorepo PR for the getter source if applicable.
- **Batching**: multiple changes in one ticket are applied to the same deploy.yaml diff and proposed in a single warp apply run. Signers get one batch per Safe / governance context rather than N small batches per individual change.
- **The strategy file is the dispatch layer**. Owner-type → submitter mapping (Step 4) is the single point that controls whether a chain's batch goes through Heimdall (via Safe Transaction Service, for AW/Foundation Safes), Squads (file submitter + `submitProposalToSquads` in the propose skill), or manual hand-off (file submitter for Turnkey / Privy / customer multisigs).
- **Fork-simulate-verify is mandatory**, not optional. The gate at Step 8 catches deploy.yaml drift, runWarpRouteApply corruption, ICA mis-derivation, and ISM/hook misconfiguration before signers see anything.
- **`warp apply` can deploy new contracts** for any update type — not just collateral additions. ISM/hook changes that introduce new module types trigger new-contract deploys; fee changes on a chain that previously had no fees trigger a new fee contract; etc. The funding preflight at Step 5 matters across all update types for this reason.
- **No customer Safe automation**. For customer-owned routes (governance type `Regular` per the artifact context), the strategy still uses `gnosisSafeTxBuilder` because the propose skill knows how to dispatch to a customer's Safe via Safe Transaction Service. But the executioner step (signing + executing) happens in the customer's Safe app, not Heimdall.
