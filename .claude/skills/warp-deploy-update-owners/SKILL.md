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
- **Key env var(s)** used during deployment (e.g. `HYP_KEY`, `HYP_KEY_ETHEREUM`)

If any of the above are missing, ask the user before proceeding.

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

Ask the user:

> **Are these the correct owner addresses?** Type `yes` to proceed, or provide corrections.

Wait for confirmation before proceeding. If the user provides corrections, update your record of owner addresses accordingly.

### 10b: Update deploy.yaml with Real Owners

Replace every occurrence of the deployer address in the deploy.yaml with the correct real owner per chain. Update `owner` fields at the chain level and inside any `tokenFee` blocks.

Write the updated deploy.yaml back to the registry path. Show the user the diff (old → new owners).

### 10c: Build and Run Warp Apply

First, start the HTTP registry in the background to use private RPC URLs:

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry
```

Run with `run_in_background: true`. Wait for the log line `Server running` and note the port (typically `3333`) and the background task ID — needed to stop the server after this step.

Assemble the warp apply command. Pass local registry first, HTTP registry second — local receives writes, HTTP provides private RPCs for reads:

```bash
cd typescript/cli

pnpm hyperlane warp apply \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --key.ethereum $MY_ETH_KEY_VAR \
  [--key.sealevel $MY_SOL_KEY_VAR]  # only if sealevel chains present
  [--key.cosmos $MY_COSMOS_KEY_VAR]  # only if cosmos chains present
  -w <TOKEN>/<chain1>-<chain2>
```

Show the user the exact command and ask:

> **Ready to run warp apply to transfer ownership?** Type `yes` to execute, or `no` to run manually.

If the user confirms, run it with a 10-minute timeout (600000ms). Show the full output on completion.

**On failure:** stop the HTTP registry (Step 10e), show the error, and stop. Do not proceed to Step 11. Common issues:

- Deployer key no longer has funds → top up and retry
- ICA address not yet deployed → deploy ICA first, then retry

### 10d: Verify Ownership with Warp Read

After warp apply completes, run warp read to confirm all ownership transfers took effect:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli

pnpm hyperlane warp read \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  -w <TOKEN>/<chain1>-<chain2>
```

Show the user the output and verify that each chain's `owner` matches the expected real owner address. Flag any discrepancies.

### 10e: Stop the HTTP Registry

After warp read completes (or on any failure after Step 10c), stop the HTTP registry using `TaskStop` with the task ID noted in Step 10c. Always stop it — even on failure — so no background process is left running.

---

## Step 11: Add CoinGecko ID and Finalize Config

### 11a: Look Up CoinGecko ID

Search CoinGecko for the token symbol/name in the registry core-config.yaml.

If found, add `coinGeckoId: <api-id>` to each **non-synthetic** token entry in the config.yaml (i.e., `collateral` and `native` entries only — NOT `synthetic` entries).

Update the config.yaml file with the coinGeckoId field added after `addressOrDenom` (or at the end of each matching token block, before `connections`).

If not found on CoinGecko, note this to the user and skip.

### 11b: Add Logo

Check the Linear ticket for an attached SVG or PNG logo (the "SVG logo" row in the ticket table). If a logo is attached:

1. Use `mcp__claude_ai_Linear__extract_images` to view the image. Then re-fetch the issue with `mcp__claude_ai_Linear__get_issue` to get a fresh signed URL (the JWT expires in ~5 minutes), and immediately `curl -s -L "<fresh-url>" -o $REGISTRY_PATH/deployments/warp_routes/<TOKEN>/logo.png` (or `.svg` if SVG is provided).
2. Save it to `$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/logo.svg` (or `logo.png` if only PNG is available).
3. Add `logoURI: /deployments/warp_routes/<TOKEN>/logo.svg` (or `/deployments/warp_routes/<TOKEN>/logo.png`) to **every** token entry in config.yaml (all legs — synthetic and native), after `coinGeckoId` (or after `addressOrDenom` if no coinGeckoId). The path is always the absolute path from the registry root.

If no logo is attached or the logo is already in the registry, skip this step.

### 11c: Show Final Config for Review

Show the user the complete final content of `<chains>-config.yaml`. Ask:

> **Does this config.yaml look correct?** Type `yes` to proceed, or describe any changes needed.

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

Write a changeset file directly to `$REGISTRY_PATH/.changeset/` — do NOT run the interactive CLI. Use a filename derived from the warp route (e.g. `add-ikas-ethereum-igra.md`):

```markdown
---
'@hyperlane-xyz/registry': minor
---

added <token-name> warp route on <chain1> and <chain2>
```

Follow the changeset style from CLAUDE.md: past tense, lowercase, concise. The bump is always `minor` for new warp routes.

### 12c: Create a Branch and Commit

Check out a new branch named after the warp route ID (replace `/` with `-`):

```bash
cd $REGISTRY_PATH
git checkout -b feat/<token-chains>
git add deployments/warp_routes/<TOKEN>/
git add .changeset/
git commit -m "feat: add <TOKEN>/<chain1>-<chain2> warp route"
```

### 12d: Push and Open PR

Push the branch and open a PR on GitHub:

```bash
cd $REGISTRY_PATH
git push -u origin HEAD
gh pr create \
  --title "feat: add <TOKEN>/<chain1>-<chain2> warp route" \
  --body "$(cat <<'EOF'
## Summary

Adds the `<TOKEN>/<chain1>-<chain2>` warp route.

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
- Always pass `--registry $(pwd)/../hyperlane-registry --registry http://localhost:<port>` to CLI commands — local first (writes succeed here), HTTP last (private RPCs take priority for reads). HTTP returning 405 on writes is expected and non-fatal.
- If the ticket has links to token contracts on block explorers, use those addresses
- Chain-level `owner` is typically an Abacus Works Safe address specified in the ticket
- `tokenFee` block `owner` defaults to the Hyperlane ICA address from `warpFees.ts` unless the ticket says otherwise
