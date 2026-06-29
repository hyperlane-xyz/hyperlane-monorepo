---
name: warp-update-resolve-artifacts
description: Foundation skill for warp-route updates. Reads the current on-chain config of a warp route via `hyperlane warp read`, enumerates every artifact (router, ProxyAdmin, ISM, hook, fee contracts) per chain, classifies each artifact's owner (auto-detects Safe / ICA / EOA; asks the user for everything else — Turnkey, Privy, MPC, custom multisig, timelock, etc.), and persists a per-artifact owner table that downstream update skills consume to know which signing path each batch needs. Read-only — no signing, no on-chain mutations.
---

# Warp Route Update — Resolve Artifacts

You are enumerating every artifact contract in an existing warp route and resolving the current on-chain owner of each. Downstream update skills (`/warp-update`, `/warp-update-extend`, future `/propose-warp-txs-heimdall`) consume this resolution to group their tx-proposal batches by signer.

## Why this is a separate skill

Different artifacts in the same warp route can be owned by different addresses. The router on arbitrum might be owned by an ICA derived from the AW ethereum Safe, while the warp-fee contracts on the same chain are owned by an ICA from the Foundation's warpFees Safe, while the ProxyAdmin might be owned by something else entirely. An update that changes a fee parameter needs to propose to the warpFees-Safe signers; an update that changes the router's ISM needs to propose to the AW-Safe signers. Without per-artifact owner enumeration, the update flow can't route tx batches correctly.

## Input

- **Linear ticket ID** (required, e.g. `AW-123`) — namespaces the resolved artifact-context file.
- **Warp route ID** (required, e.g. `ETH/arbitrum-base`) — the route to resolve artifacts for.

If either is missing, ask the user.

---

## Step 1: Start the HTTP Registry

Invoke `/start-http-registry` (no extra flags — this skill is read-only and doesn't need `--writeMode`). The HTTP registry serves the central chain-metadata config so `warp read` hits private/pinned RPCs instead of rate-limited public ones. The `/proc` cmdline-scan fallback documented in `/warp-deploy-init-route` applies here too if `TaskStop` doesn't clean up the process at the end of this skill.

---

## Step 2: Run `warp read`

```bash
pnpm --silent -C typescript/cli hyperlane warp read \
  --registry http://localhost:<port> \
  --warp-route-id <WARP_ROUTE_ID>
```

`warp read` is a read-only command and does NOT require a key. The output is a YAML document with the deploy.yaml shape — one block per chain, with on-chain values populated for `owner`, `interchainSecurityModule`, `hook`, `proxyAdmin`, and any `tokenFee.feeContracts` block. Capture the full output for the next steps.

**Expected non-fatal warnings**: `warp read` emits `Failed to get configured rebalancers for token …` / `Failed to get allowed rebalancer bridges for token …` errors on routes that don't have a rebalancer configured (most non-multi-collateral routes). The errors are noisy but non-fatal — the read completes and the YAML is still produced. Ignore them unless the YAML is empty or `❌ Warp route config read successfully:` is missing from the output.

If `warp read` fails on a specific chain (real RPC error, missing chain in registry, contract reverted in a way that aborts the read), surface the per-chain error and continue with the chains that succeeded — partial resolution is more useful than nothing. Mark the failed chain's row as `❌ READ_FAILED` in the final table.

---

## Step 3: Extract Artifacts Per Chain

From the `warp read` output, build a flat list of `(chain, artifactType, address, ownerAddress)` tuples. The artifact types and where they appear in the YAML:

### Top-level artifacts (always present per chain)

| Artifact type | Source field in `warp read` output                                                           | Shape  | Owner from warp read?   |
| ------------- | -------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| `router`      | top-level chain block (the warp-token contract address is the route entry) + `<chain>.owner` | flat   | ✅ (the chain `.owner`) |
| `proxyAdmin`  | `<chain>.proxyAdmin.{address, owner}`                                                        | nested | ✅                      |
| `fee:routing` | `<chain>.tokenFee.{address, owner}` (synthetic side only)                                    | nested | ✅                      |
| `fee:linear`  | each `<chain>.tokenFee.feeContracts.<other-chain>.{address, owner, bps}`                     | nested | ✅                      |

### ISM and hook artifacts (flat-or-nested — walk the tree)

`interchainSecurityModule` and `hook` are NOT always flat addresses. They can be either:

1. **A flat string** — typically `0x0000000000000000000000000000000000000000` ("use mailbox default", skip as artifact) or a non-zero address for an existing custom contract whose internals aren't surfaced by `warp read`.
2. **A nested object** — recent routes use complex ISM trees (e.g. `staticAggregationIsm` of `rateLimitedIsm` + `pausableIsm` + `defaultFallbackRoutingIsm`) or hook trees (e.g. `amountRoutingHook`). Each sub-component is its own deployed contract with its own `address`, `type`, and (sometimes) `owner`.

**Algorithm for each ISM / hook field**:

1. If `typeof field === 'string'`:
   - `0x0…0` (zero address) → uses mailbox default. Skip — do NOT add a row.
   - Non-zero address → custom contract. Record as ONE artifact row with `type: <unknown-or-from-context>`, `address: <field-value>`. Resolve owner via `cast call <addr> "owner()(address)"`. If the contract doesn't implement `owner()`, mark `owner: null` + `type: immutable`.
2. If `field` is an object:
   - **Walk the tree depth-first**. At each node that has an `owner` field, record it as a separate artifact (with `address`, `type`, `owner`, and any type-specific fields like `maxCapacity` / `paused`). Aggregation containers themselves (e.g. `staticAggregationIsm`) typically have NO `owner` — they're constructor-immutable; do not record them as actionable artifacts, but DO record each of their constituent sub-modules.
   - Containers to descend into:
     - `modules: [...]` — array of sub-modules (aggregation ISMs)
     - `domains: { <chainName>: <ism-or-hook> }` — map keyed by remote chain (routing ISMs / hooks)
     - `lowerHook`, `upperHook` — nested hook fields (`amountRoutingHook`)
     - any other field whose value is itself an object with `type` set
   - At each leaf node with an `owner`, record a row like `{ chain, type: <node.type>, address: <node.address>, owner: <node.owner>, details: { ...type-specific fields... } }`.

**Real example** — `evENI/bsc` `interchainSecurityModule`:

```yaml
interchainSecurityModule:
  address: '0x57078Bc6...'
  type: staticAggregationIsm # container, no owner — skip
  modules:
    - {
        address: '0x3b9486c2...',
        type: rateLimitedIsm,
        owner: '0xf000...',
        maxCapacity: '20999...',
      } # → 1 artifact row
    - {
        address: '0x58E16564...',
        type: defaultFallbackRoutingIsm,
        owner: '0xf000...',
        domains: {},
      } # → 1 artifact row
    - {
        address: '0x67a1910e...',
        type: pausableIsm,
        owner: '0xf000...',
        paused: false,
      } # → 1 artifact row
  threshold: 3
```

That single `interchainSecurityModule` field produces THREE artifact rows in the resolution table — one per leaf sub-ISM with an owner.

### `cast call` fallback for any missing owner field

If a nested-shape artifact's `owner` is unexpectedly missing (rare; might happen if the warp read schema changes or for non-standard contracts), fall back to:

```bash
cast call <artifact-address> "owner()(address)" --rpc-url <chain-rpc-from-registry>
```

Always prefer the `warp read` value when present — it's the canonical source.

---

## Step 4: Classify Each Owner

Owner classification is **open-set** — the auto-detection rules only cover a few shapes; for everything else the user supplies the type. Do NOT assume contract-not-Safe is necessarily an ICA. Real-world owners include Hyperlane ICAs, Gnosis Safes, Squads multisigs, Turnkey wallets, Privy embedded wallets, other MPC wallet contracts, custom non-Gnosis multisigs, timelocks, and one-off bespoke owners.

For each unique owner address, run the following sequence.

### 4.0: Probe Shortcut — Match Against Known Hyperlane Governance Maps

Most Hyperlane-owned warp routes have owners that already live in the canonical governance config in `typescript/infra/config/environments/mainnet3/governance/`. The Safe / ICA / timelock / ProxyAdmin maps there are the source of truth for those addresses across all chains, organized by governance group (AW / Foundation warpFees / Regular / Irregular / oUSDT). Use them as a probe shortcut — a direct match means you can skip the on-chain `cast` and `hyperlane ica deploy` calls in 4a–4c and resolve the type from the map directly.

Read the lookup helpers in `typescript/infra/config/environments/mainnet3/governance/utils.ts` (`getGovernanceSafes`, `getGovernanceIcas`, `getSafesByGovernanceForChain`, `getGovernanceTimelocks`, `getWarpFeeOwner`) and the per-group address maps in `safe/`, `ica/`, `timelock/`, `proxy-admin/`. For each owner address being classified:

- Match in `safe/<group>.ts[chain]` → `type: Safe`. Skip 4b's `VERSION()` probe.
- Match in `ica/<group>.ts[chain]` → `type: ICA`, `origin: ethereum`, `controllingOwner: <safe-from-the-same-group-on-ethereum>`. Skip 4c's `hyperlane ica deploy` derivation — the map already encodes the deterministic result. Still run 4c.1 to classify the controller (it'll usually match `safe/<group>.ts[ethereum]` and short-circuit too).
- Match in `timelock/<group>.ts[chain]` → `type: Timelock`, and record the underlying owner from the same group's Safe map as the resolution target.
- Match in `proxy-admin/<group>.ts[chain]` → informational annotation that the artifact's ProxyAdmin is the canonical one; the ProxyAdmin's _own_ owner is classified separately.

If no map matches, fall through to 4a–4d for on-chain detection. The governance maps are a cache of the most common Hyperlane-controlled cases, **not exhaustive** — customer routes, ad-hoc owners, third-party-controlled addresses, and any non-Hyperlane warp route won't be there. Don't assume a non-match means "wrong" — it just means the address isn't in this monorepo's governance config.

You MAY add a free-form governance label (e.g. `details: "matched awSafes[arbitrum]"`) to the artifact's owner record when a map matches, to make the resolution table more readable. The schema does NOT require a structured `governanceType` field — many warp routes aren't governance-controlled at all.

### 4a. Is the owner an EOA?

```bash
cast code <owner-address> --rpc-url <chain-rpc>
```

- `0x` → **plain EOA**. EOAs are red flags as long-term production owners — surface as `❌ EOA` and **stop the skill** with a clear error. Do not persist the artifact context with an EOA owner; the route is in a corrupt state that needs human investigation first.
- `0xef0100<20-byte-delegate>` (46 chars, EIP-7702) → **EIP-7702-delegated EOA**. Same outcome — surface and stop.
- Anything else → contract, proceed to 4b.

### 4b. Auto-detect: Gnosis Safe

```bash
cast call <owner-address> "VERSION()(string)" --rpc-url <chain-rpc>
```

- Returns a version string (e.g. `"1.3.0"`) → classify as `type: Safe`, record the version. Done.
- Reverts or returns empty → not a Safe; proceed to 4c.

### 4c. Auto-detect: Hyperlane ICA (only if ethereum is in the route)

If the route has an `ethereum` leg, attempt one ICA derivation using the ethereum leg's `owner` as the candidate controlling owner:

```bash
pnpm --silent -C typescript/cli hyperlane ica deploy \
  --registry http://localhost:<port> \
  --origin ethereum \
  --chains <this-chain> \
  --owner <ethereum-leg-owner-address>
```

This command is idempotent and read-mostly: it prints the deterministic ICA address derived from `(ethereum, ethereum-leg-owner, ICA router on <this-chain>, ISM)`. No tx is sent if the ICA already exists.

- If the derived address **matches** the on-chain owner: classify as `type: ICA`, `origin: ethereum`, `controllingOwner: <ethereum-leg-owner>`. Then proceed to 4c.1 to classify the controller itself.
- If the derived address **does not match** OR ethereum isn't in the route: fall through to 4d. The owner could still be an ICA controlled from a different chain, OR something else entirely.

### 4c.1. Classify the controller (always — when the owner is an ICA)

Recording `controllingOwner: <address>` is not enough. Downstream `/warp-update` Step 4a needs to know _what kind of account_ the controller is — Safe, EOA, another ICA, Squads, MPC wallet, etc. — to pick the right `internalSubmitter` for the `interchainAccount` strategy.

First, check the governance maps again (from 4.0) against the controller address on its origin chain — most controllers in Hyperlane-owned routes are Safes that already live in `safe/<type>.ts`. A direct match yields `controllerType: Safe` + `controllerGovernanceType: <type>` without any on-chain probe.

If no governance map matches, recursively apply the heuristics from 4a and 4b against the `controllingOwner` on its origin chain:

```bash
# Is the controllingOwner a contract on origin?
cast code <controllingOwner> --rpc-url <origin-rpc>

# If yes, is it a Gnosis Safe?
cast call <controllingOwner> "VERSION()(string)" --rpc-url <origin-rpc>
```

Auto-detectable outcomes:

- `cast code` returned bytecode AND `VERSION()` returned a Gnosis Safe version string → `controllerType: Safe`. This is the most common case for production warp routes (AW Safe / Foundation Safe / customer Safes control most ICAs).
- `cast code` returned `0x` → `controllerType: EOA`. Common for test routes, contributor EOAs, or one-off setups.

**If the controller is a contract but neither a Safe nor anything else the skill can determine on its own, halt and ASK THE USER inline — do not record `Unknown` and defer to downstream.** Open-set classification belongs here, in the foundation skill, not buried in a downstream propose failure that's hard to recover from. The controller could be another ICA (recursive — re-apply 4c against it), a Squads multisig (on SVM origins), a Turnkey wallet, a Privy embedded wallet, an MPC wallet, a custom multisig, a timelock, or something bespoke. Don't guess.

Halt message shape:

> _"Controller of ICA `<owner-address>` on `<this-chain>` is `<controllingOwner>` on `<origin-chain>` — contract, not a Gnosis Safe. I can't classify it autonomously. What is it? Options: another ICA (supply its origin chain + controllingOwner), Squads multisig PDA, Turnkey wallet, Privy embedded wallet, MPC wallet (other), custom multisig, timelock (supply its underlying owner), other — supply a short description. The classification gates downstream submitter choice; I need an answer before persisting."_

```test
[CONFIRM: Classify controller <controllingOwner> as <user-supplied-type>]
```

If the user says it's another ICA, recursively apply 4c against the new controller (using the user-supplied origin + controllingOwner). Recursion stops at an EOA, a Safe, or a non-ICA classification.

**Print the resolved controller classification on every ICA artifact** — even (especially) when it's the common controller=Safe case. Making the type explicit is what prevents the unconscious "ICA controllers are always Safes" prior from re-emerging in the _other_ direction either:

> _"arbitrum router owner `0x645F…d875` resolves to ICA(ethereum, controllingOwner=`0x3965…C5b6`); controller is **Safe**. Downstream `interchainAccount` strategy uses `internalSubmitter: gnosisSafeTxBuilder` targeting the controlling Safe on ethereum."_

> _"base proxyAdmin owner `0xC92c…651c` resolves to ICA(ethereum, controllingOwner=`0x3f13…0913`); controller is **EOA**. Downstream `interchainAccount` strategy must use `internalSubmitter: jsonRpc` or `file` — NOT `gnosisSafeTxBuilder`."_

If the same `controllingOwner` is referenced by multiple ICAs in this route, classify it once and reuse; still print the controller line for every artifact that resolves through it.

### 4d. Ask the user — open-set classification

When auto-detection didn't match a Safe or a route-ethereum-derived ICA, ask the user to classify the owner. Surface the context and let them pick — don't pre-pick. End your message with one `[CONFIRM:]` per unclassified owner:

```
Owner address: <owner-address> on <chain>
Status: contract (has code), not a Gnosis Safe, not derivable as ICA from this route's ethereum leg.

What type of owner is this? Possible types:
- ICA (Hyperlane Interchain Account) controlled from a different origin chain — also supply origin chain + controlling owner address on origin
- Squads (Solana multisig PDA) — supply the multisig PDA's role if multi-vault
- Turnkey wallet — supply the Turnkey org / wallet ID for reference
- Privy embedded wallet — supply the Privy project ID / wallet reference for reference
- MPC wallet (other) — supply the provider name + any wallet ID
- Custom multisig (not Gnosis) — supply the multisig type if known
- Timelock — supply the underlying owner (where the queued ops resolve to)
- Other — supply a short description
- Unknown — cannot identify; downstream proposals touching artifacts owned by this address will halt
```

```test
[CONFIRM: Classify <owner-address> as <user-supplied-type>]
```

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

If the user supplies `type: ICA` with a different origin, verify the derivation by re-running the `hyperlane ica deploy` command with the user-supplied origin + controlling owner. If the derived address still doesn't match, the user-supplied origin is wrong — surface the mismatch and re-prompt.

For all other types (Turnkey / Privy / MPC / custom-multisig / timelock / other), the skill records the classification without further verification. The signing-path mapping is downstream's responsibility (most non-Safe / non-ICA / non-Squads types map to `file` submitter + manual hand-off; downstream skills decide).

### 4e. SVM owners

For SVM owners (Solana base58 pubkeys), Squads classification is Phase 2 wiring; flag as `type: Squads`, `notes: classification not yet automated for SVM` and continue. If the user knows it's NOT a Squads multisig, they can override via 4d.

---

## Step 5: Drift Detection

Compare the on-chain owner returned by `warp read` against the `owner` field in the registry's `deploy.yaml` for the same artifact:

```bash
cat $REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-deploy.yaml
```

For each artifact, if the on-chain owner ≠ deploy.yaml `owner`:

- Record as drift with severity `warning` (not error) in the artifact context.
- Surface the list to the user at the end — drift typically means a prior transfer didn't propagate, or someone reset ownership out of band.

Drift doesn't block this skill from persisting; downstream update skills decide whether drift blocks their proposes.

---

## Step 6: Show Resolution Table

Present a per-artifact table to the user before persisting:

```
Chain     | Artifact         | Address                                       | Owner                         | Owner type   | Drift
arbitrum  | router           | 0xA2cB89330E057a2cF76C6945aEAD22631c4df061   | 0x645FE065...3bd875           | ICA (eth)    | ✅
arbitrum  | proxyAdmin       | 0x...                                         | 0x645FE065...3bd875           | ICA (eth)    | ✅
arbitrum  | fee:routing      | 0x...                                         | 0xICAfromFoundationSafe...    | ICA (eth)    | ✅
arbitrum  | fee:linear:base  | 0x...                                         | 0xICAfromFoundationSafe...    | ICA (eth)    | ✅
base      | router           | 0xfBB4EE517Ed80C027Fd8217Db53ffD8190792522   | 0xC92c781F...Bb651c           | ICA (eth)    | ⚠️ drift
base      | proxyAdmin       | 0x...                                         | 0xTurnkeyOwner...             | Turnkey      | ✅
```

Also surface the grouped-by-owner view (each owner → list of artifacts they own), since that's the shape downstream propose flows need.

End the message with:

```test
[CONFIRM: Persist artifact context for <warp-route-id> on ticket <ticket-id>]
```

---

## Step 7: Persist Artifact Context

Write `~/.hyperlane/update-context/<ticket-id>.yaml`:

```yaml
ticket: <ticket-id>
warpRouteId: <WARP_ROUTE_ID>
resolvedAt: '<ISO-8601 timestamp>'

artifacts:
  - chain: arbitrum
    type: router
    address: '0xA2cB89330E057a2cF76C6945aEAD22631c4df061'
    owner:
      address: '0x645FE06507C8a188494d3E755B248a8dbF3bd875'
      type: ICA # Safe | ICA | Squads | Turnkey | Privy | MPC | CustomMultisig | Timelock | Other | Unknown
      origin: ethereum # for ICA only
      controllingOwner: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6' # for ICA only — the controller on the origin chain (e.g. AW Safe on ethereum)
      controllerType: Safe # for ICA only — Safe | EOA | ICA | Squads | Turnkey | Privy | MPC | CustomMultisig | Timelock | Other. Gates downstream `interchainAccount.internalSubmitter` choice.
      details: null # free-form notes (e.g. Turnkey org ID, governance label if matched against a known map, etc.)
    drift: null # or { expected: '0x...', actual: '0x...', severity: 'warning' }

  - chain: arbitrum
    type: fee:routing
    address: '0x...'
    owner:
      address: '0xICAfromFoundationSafe...'
      type: ICA
      origin: ethereum
      controllingOwner: '0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0' # Foundation warpFees Safe
    drift: null

  - chain: base
    type: proxyAdmin
    address: '0x...'
    owner:
      address: '0xTurnkeyOwner...'
      type: Turnkey
      details: 'Turnkey org abc-123, wallet xyz-456' # user-supplied at 4d
    drift: null

groupedByOwner:
  - owner: '0x645FE06507C8a188494d3E755B248a8dbF3bd875'
    type: ICA
    origin: ethereum
    controllingOwner: '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6'
    controllerType: Safe
    artifacts:
      - { chain: arbitrum, type: router }
      - { chain: arbitrum, type: proxyAdmin }

  - owner: '0xTurnkeyOwner...'
    type: Turnkey
    details: 'Turnkey org abc-123, wallet xyz-456'
    artifacts:
      - { chain: base, type: proxyAdmin }

drift:
  - chain: base
    artifact: router
    expected: '0x645FE06507C8a188494d3E755B248a8dbF3bd875'
    actual: '0x999...'
    severity: warning
```

The `groupedByOwner` block is the most useful downstream shape — it's what propose skills consume to construct one tx batch per signing path.

---

## Step 8: Stop the HTTP Registry

Stop the background task started in Step 1 via `TaskStop` + the `/proc` cmdline-scan fallback (per `/warp-deploy-init-route`).

---

## Step 9: Hand Off to Downstream

Tell the user:

> **Artifact context resolved and saved to `~/.hyperlane/update-context/<ticket-id>.yaml`.** Downstream warp-update skills (`/warp-update`, `/warp-update-extend`, `/propose-warp-txs-heimdall`) consume this file to know which owners need to sign for the diff being applied. Run those next; they auto-load this artifact.

For owners with types that don't yet have a native submitter path (Turnkey / Privy / MPC / custom multisig / timelock / Other / Unknown), downstream propose flows will fall back to the `file` submitter and emit TX JSON for manual hand-off to the owner's signing tooling.

---

## Notes

- **Read-only skill.** Nothing on chain is mutated. The `hyperlane ica deploy` call in Step 4c without `--deploy` is idempotent — it only derives + reports the deterministic address.
- **Open-set classification.** Contract-but-not-Safe is NOT assumed to be an ICA. Auto-detection covers the cheap cases (EOA reject, Safe via VERSION(), ICA via route-ethereum derivation). Everything else the user classifies. Owner types intentionally include non-multisig wallet shapes (Turnkey, Privy, MPC) because real customer routes use them.
- **Drift is a warning, not a halt.** This skill records drift but doesn't decide what to do about it; downstream update skills surface drift to the human in their CONFIRM gates and let the human decide whether to proceed.
- **EOA owner halts the skill.** An EOA on the production owner slot is a corruption signal and needs human investigation before any update runs.
- **SVM artifacts default to Squads classification.** This is a heuristic for SVM owners pending Phase 2 wiring; the user can override at 4d if it's actually some other shape.
- **Idempotent.** Re-running for the same ticket-id overwrites the artifact context. Useful when route state changed between runs (e.g. ownership transferred mid-flow).
