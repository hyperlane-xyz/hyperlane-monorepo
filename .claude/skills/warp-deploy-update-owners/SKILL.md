---
name: warp-deploy-update-owners
description: Post-deployment ownership transfer and registry PR for a warp route. Transfers ownership from the temporary deployer address to real owners, adds CoinGecko ID, commits, and opens a registry PR. Run after warp-deploy-init completes deployment.
---

# Warp Route Deploy — Update Owners & Finalize

You are transferring ownership of a newly deployed warp route and opening the registry PR.

## Input

The user provides (or you have from a prior `/warp-deploy-init` session):

- **Linear ticket URL or ID** (e.g. `https://linear.app/hyperlane/issue/ABC-123`)
- **Registry path** (defaults to `$(pwd)/../hyperlane-registry`)

If any of the above are missing, ask the user before proceeding.

### Key Context (Prerequisite)

This skill runs `warp apply` to transfer ownership and needs a deployer key per protocol to sign the txs. It auto-loads `~/.hyperlane/key-contexts/<ticket-id>.yaml` produced by `/warp-deploy-select-keys`. If the artifact does not exist, invoke `/warp-deploy-select-keys <ticket-id>` first.

For each unique protocol in the route, read `keys.<protocol>.name` and `keys.<protocol>.source` from the artifact. Expand `<KEY_<PROTOCOL>_VALUE>` placeholders in the commands below per the key-value expansion legend in `/warp-deploy-validate-owners`. Display the resolved name + derived address from the artifact at every `[CONFIRM:]` gate so the human can spot a wrong-key foot-gun.

### Reading the Linear Ticket

Fetch the Linear ticket to extract:

- Warp route ID (e.g. `RISE/bsc-ethereum`)
- Chains involved
- Real owner addresses per chain (if explicitly specified in the ticket)
- Whether custom warp fee owners are specified (see below)

### Determining Chain-Level Owners

For each chain in the route:

1. If the ticket explicitly specifies an owner address for that chain, use it.
2. For the ethereum chain, the owner is typically the Abacus Works Ethereum Safe (from the ticket).
3. For other chains, look up the ICA address in:
   ```
   typescript/infra/config/environments/mainnet3/governance/ica/aw.ts
   ```
   If the chain's entry is **commented out**, the ICA has not been deployed yet — see Step 10a below for how to deploy it.

### Determining Warp Fee Owners

For `tokenFee` blocks in deploy.yaml, the owner defaults to the **Hyperlane ICA address** for each chain from:

```
typescript/infra/config/environments/mainnet3/governance/ica/warpFees.ts
```

Read this file to look up the ICA address for each chain where the tokenFee contracts are deployed. Use these as the fee owners **unless the Linear ticket explicitly specifies different fee owner addresses**.

If a chain's entry is **commented out** in `warpFees.ts`, the ICA has not been deployed yet — see Step 10a below for how to deploy it.

---

## Step 10: Transfer Ownership to Real Owners

The deployed contracts are currently owned by the temporary deployer address. This step transfers ownership to the real owners from the ticket.

### 10a: Deploy Missing ICAs (if needed)

**When to deploy ICAs:** Check the ticket for the Ethereum Safe address used as the governance owner. Two scenarios:

1. **Standard AW safe** (e.g. `0x1234...` matching an entry in `aw.ts`): Only deploy ICAs for chains that are commented out in `aw.ts`/`warpFees.ts`.
2. **Custom/route-specific safe** (a safe not in `aw.ts`, or the ticket says "ICA on all chains"): Deploy fresh ICAs from this safe for **every non-ethereum chain** in the route, regardless of what exists in `aw.ts`. The existing entries in `aw.ts` are from different safes and do not apply.

For each chain needing an ICA, deploy from `typescript/infra`:

```bash
cd typescript/infra

pnpm tsx scripts/keys/get-owner-ica.ts \
  --environment mainnet3 \
  --ownerChain ethereum \
  --owner <ETHEREUM_SAFE_ADDRESS> \
  --chains <chain1> <chain2> ... \
  --deploy
```

Pass chains as **space-separated** values (NOT comma-separated — the script uses `[array]` type and rejects comma-separated input). You can pass all chains in one command. Each command prints the new ICA address on completion. Collect all new addresses before proceeding.

**These new ICAs are route-specific and should NOT be added to `aw.ts` or `warpFees.ts`** — they only belong in the deploy.yaml for this route.

### 10b: Confirm Real Owners

Show the user the real owner addresses for both chain-level owners and fee owners. Present them clearly per chain, e.g.:

```
Chain owners:
  ethereum:  0xSafe...   (from ticket)
  arbitrum:  0xICA...    (from aw.ts or newly deployed)

Warp fee owners:
  ethereum:  0x89d295dBB62aAb434BEd1D372b04c468e828eC9b  (from warpFees.ts)
  arbitrum:  0x6f0Cfe5fD2E4188AD68b7f8ceB135DD68DF629C7  (from warpFees.ts)
```

If the ticket specifies custom fee owners, show those instead and label them accordingly.

Ask the user to confirm or provide corrections. End your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Owner addresses are correct]
```

Wait for confirmation before proceeding. If the user provides corrections, update your record of owner addresses accordingly.

### 10c: Update deploy.yaml with Real Owners

Update the deploy.yaml by replacing the deployer address with the correct real owner per chain. Only update explicit `owner` keys: the chain-level `owner` field and `owner` inside any `tokenFee` and `feeContracts` blocks. Do not do a global string replace — parse the YAML structure and target only these specific keys.

Write the updated deploy.yaml back to the registry path. Show the user the diff (old → new owners).

### 10d: Build and Run Warp Apply

First, start the HTTP registry in the background to use private RPC URLs:

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry --writeMode
```

Run with `run_in_background: true`. Wait for the log line `Server running` and note the port (typically `3333`) and the background task ID — needed to stop the server after this step.

Assemble the warp apply command. Use only the HTTP registry — started with `--writeMode` so it handles both private RPC reads and writes. Expand `<KEY_<PROTOCOL>_VALUE>` per the artifact's `source` field (see the key-value expansion legend in `/warp-deploy-validate-owners`):

```bash

pnpm --silent -C typescript/cli hyperlane warp apply \
  --registry http://localhost:<port> \
  --key.ethereum <KEY_ETHEREUM_VALUE> \
  [--key.sealevel <KEY_SEALEVEL_VALUE>]  # only if sealevel chains present
  [--key.cosmos <KEY_COSMOS_VALUE>]      # only if cosmos chains present
  -w <WARP_ROUTE_ID>
```

Where `<WARP_ROUTE_ID>` is the stable route ID from init-route Step 7a (e.g. `USDS/igra` or `USDS/ethereum-igra`).

Show the user the exact command, then end your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Run warp apply to transfer ownership for <WARP_ROUTE_ID>]
```

If the user confirms, run it. Show the full output on completion.

**On failure:** stop the HTTP registry (Step 10e), show the error, and stop. Do not proceed to Step 11. Common issues:

- Deployer key no longer has funds → top up and retry
- ICA address not yet deployed → deploy ICA first, then retry

### 10e: Verify the Route with Comprehensive `warp check`

After warp apply completes, run the canonical CLI verifier against the deployed route. This is the **gate** before downstream steps (monitor deploy, registry PR) — if `warp check` reports violations, the route isn't actually in the target state and the rest of the flow shouldn't proceed.

```bash

pnpm --silent -C typescript/cli hyperlane warp check \
  --registry http://localhost:<port> \
  --warp-route-id <WARP_ROUTE_ID>
```

This is the comprehensive check — compares the on-chain state of every contract in the route against the target `deploy.yaml`. No violations = the deployment matches the config (ownership, ISM, hook, fee, rate-limit, all of it).

**Additionally, IF any chain owner in the route is an ICA** (per the resolution from `/warp-deploy-validate-owners`, or visible in the deploy.yaml `owner` fields), also run the ICA-aware variant:

```bash
pnpm --silent -C typescript/cli hyperlane warp check --ica \
  --origin <ICA_ORIGIN_CHAIN> \
  --originOwner <CONTROLLING_OWNER_ON_ORIGIN> \
  --chains <ICA_CHAINS> \
  --warp-route-id <WARP_ROUTE_ID> \
  --registry http://localhost:<port>
```

- `--origin` is the chain where the controlling Safe / EOA lives (typically `ethereum`).
- `--chains` is the space-separated list of destination chains whose owners are ICAs derived from that origin.
- `--originOwner` is the controlling Safe / EOA address on `--origin` — **REQUIRED when the origin chain is NOT one of the chains in the route**. If you omit it in that case, the CLI errors with `Origin chain <name> does not have an owner configured`. When the origin chain IS in the route (e.g. ethereum-collateral routes), the CLI infers `--originOwner` from the route's ethereum-leg `owner` field and you can omit the flag. Safest to always pass it explicitly.

This verifies each ICA address derives correctly from the configured controlling owner.

The `warp check` run may also emit transient warnings from public RPCs that the CLI falls back to — most commonly `drpc.org` returning HTTP 408 `Request timeout on the free tier`. These are harmless noise from the public free-tier endpoint and don't affect the check result. Ignore unless the run actually fails.

Show the user the full `warp check` output. If there are violations:

- Surface each violation clearly (chain, field, actual vs expected).
- **Stop**. Do not proceed to Step 11 / 12 (the monorepo register-route and monitor deploy that follow). The route isn't in the right state — investigate and re-apply before continuing.

### 10f: Stop the HTTP Registry

After `warp check` completes (or on any failure after Step 10d), stop the HTTP registry using `TaskStop` with the task ID noted in Step 10d. Always stop it — even on failure — so no background process is left running.

For minimal-tool sandboxes (no `ps`/`lsof`/`pkill`/`fuser`), use the `/proc` cmdline-scan fallback documented in `/warp-deploy-init-route` (search "TaskStop" in that skill). Always run the fallback after `TaskStop` — idempotent if the process is already gone.

---

## Step 11: Add CoinGecko ID and Finalize Config

> **YAML sort-order rules (applies to every edit in this step and any registry YAML edit in this skill).** The registry CI / CodeRabbit policy is strict on two levels of alphabetical sorting:
>
> 1. **Chain entries at the top level must be in alphabetical order by chain name.** E.g. an arbitrum + base + ethereum route has `arbitrum:` before `base:` before `ethereum:`. If you're inserting a new chain or restructuring an existing file, re-sort the top level by chain name.
> 2. **Keys within each chain entry must be in strict alphabetical order.** When adding a new field (e.g. `coinGeckoId`, `logoURI`), insert it at its alphabetical position — never at the top, bottom, or "after a specific sibling key". Example final key order for a config.yaml token block: `addressOrDenom`, `chainName`, `coinGeckoId`, `connections`, `decimals`, `logoURI`, `name`, `standard`, `symbol`, `tokenType`.

### 11a: Look Up CoinGecko ID

Search CoinGecko for the token symbol/name in the registry core-config.yaml.

If found, add `coinGeckoId: <api-id>` to each **non-synthetic** token entry in the config.yaml (i.e., `collateral` and `native` entries only — NOT `synthetic` entries). **Insert at the alphabetical position in the token block** (between `chainName` and `connections`). Do NOT append at the top or bottom — that fails the sort check.

If not found on CoinGecko, note this to the user and skip.

### 11b: Add Logo

Check if `/warp-deploy-init-route` already cached the logo locally at `$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/logo.svg` (or `logo.png`) — that skill downloads the Linear-uploaded logo eagerly after fetching the ticket, so the JWT signed-URL doesn't expire by the time we get here.

1. **If the local file exists** (the happy path): proceed directly to step 3.
2. **If the local file is missing** (e.g. init-route was skipped or the cached file got purged): re-fetch the issue via `mcp__plugin_linear_linear__get_issue` to obtain a fresh signed URL, then immediately:
   ```bash
   curl -sSL "<fresh-signed-url>" -o "$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/logo.<ext>"
   ```
   Use `logo.svg` if the upload is SVG; `logo.png` otherwise.
3. Add `logoURI: /deployments/warp_routes/<TOKEN>/logo.svg` (or `/deployments/warp_routes/<TOKEN>/logo.png`) to **every** token entry in config.yaml (all legs — synthetic and native). **Insert at its alphabetical position** — `logoURI` lands between `decimals` and `name`. The path is always the absolute path from the registry root.

If no logo is attached to the ticket and no local file exists, skip this step.

### 11b-check: Verify Sort Order Before Step 11c

Before showing the file for review, confirm both invariants on the final config.yaml:

- Top-level chain entries are in alphabetical order by chain name.
- Within each chain's token block, all keys are in alphabetical order (visual scan against the canonical key list above is sufficient; for stronger confidence pipe through `yq` and compare).

If either invariant fails, fix the file before proceeding to 11c. The registry CI / CodeRabbit will block the PR otherwise.

### 11c: Show Final Config for Review

Show the user the complete final content of `<chains>-config.yaml`, then end your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Proceed with config.yaml as written]
```

Do not proceed to Step 12 until the user confirms.

---

## Step 12: Commit, Push, and Open Registry PR

### 12a: Check Registry Git Status

```bash
cd $REGISTRY_PATH && git status
```

Show the user the list of changed/new files. There should be at minimum:

- `deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml`
- `deployments/warp_routes/<TOKEN>/<chains>-config.yaml`

### 12b: Write Changeset

Invoke `/add-registry-changeset` with:

- Change summary: `added <token-name> warp route on <chain1> and <chain2>`
- Bump: `minor` (new warp route)
- Filename slug: `add-<token>-<chains>` (e.g. `add-ikas-ethereum-igra`)

The shared skill writes the file directly to `$REGISTRY_PATH/.changeset/<slug>.md`. Don't run the interactive `pnpm changeset` CLI.

### 12c: Create a Branch and Commit

Check out a new branch named after the warp route ID (replace `/` with `-`):

```bash
cd $REGISTRY_PATH
git checkout -b feat/<token-chains>
git add deployments/warp_routes/<TOKEN>/
git add .changeset/
git commit -m "feat: add <WARP_ROUTE_ID> warp route"
```

### 12d: Push and Open PR

Push the branch and open a PR on GitHub:

```bash
cd $REGISTRY_PATH
git push -u origin HEAD
gh pr create \
  --base main \
  --title "feat: add <WARP_ROUTE_ID> warp route" \
  --body "$(cat <<'EOF'
## Summary

Adds the `<WARP_ROUTE_ID>` warp route.

| Field | Value |
| ----- | ----- |
| **Linear** | <linear-issue-url> |
| **Token** | <token-name> (<TOKEN>) |
| **Route type** | <e.g. native → synthetic, collateral → synthetic> |
| **Chains** | <chain1> (<type>), <chain2> (<type>), ... |
| **Decimals** | <decimals> |
| **Warp fee** | <fee in bps, or "none"> |
| **Owners** | <chain>: `<owner-address>`, ... |

### Contracts deployed

| Chain | Contract | Address |
| ----- | -------- | ------- |
| <chain> | <HypNative / HypSynthetic / HypERC20Collateral / ...> | `<address>` |
| ... | ... | ... |

### ICAs deployed

Only include this section if fresh ICAs were deployed during Step 10a. List each chain and address:

| Chain | ICA Address | Owner Safe |
| ----- | ----------- | ---------- |
| <chain> | `<ica-address>` | `<safe-address>` |
| ... | ... | ... |

If no ICAs were deployed (all owners were already known), omit this section entirely.

### Test transfers

Only include this section if warp send tests were run (Step 9 in warp-deploy-init-route). List each direction tested with its explorer link:

| From | To | Message ID | Status |
| ---- | -- | ---------- | ------ |
| <chain> | <chain> | [`<short-id>`](<explorer-link>) | ✅ |
| ... | ... | ... | ... |

If no test transfers were run, omit this section entirely.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in the PR body with real values from the deployment:

- Route type: describe the chain types (e.g. "igra (native) → ethereum (synthetic)")
- Contracts: list each deployed contract address from the config.yaml `addressOrDenom` fields
- Owners: list per-chain real owner addresses from the final deploy.yaml
- ICAs: list any ICAs deployed in Step 10a (omit section if none)
- Test transfers: list message IDs and explorer links from Step 9 (omit section if none)

Show the user the PR URL when done.

After showing the PR URL, tell the user:

> **Once this PR is merged**, run `/warp-deploy-register-route` to add the warp route ID to the monorepo and update `.registryrc`.

---

## Notes

- The registry path is `$(pwd)/../hyperlane-registry` when run from the monorepo root. The hyperlane-registry repo is expected to be cloned at the same level as hyperlane-monorepo.
- Always pass `--registry http://localhost:<port>` to CLI commands — the HTTP registry is started with `--writeMode` so it handles both private RPC reads and artifact writes.
- If the ticket has links to token contracts on block explorers, use those addresses
- Chain-level `owner` is typically an Abacus Works Safe address specified in the ticket
- `tokenFee` block `owner` defaults to the Hyperlane ICA address from `warpFees.ts` unless the ticket says otherwise
