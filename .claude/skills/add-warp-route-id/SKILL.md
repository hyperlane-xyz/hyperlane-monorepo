---
name: add-warp-route-id
description: Post-registry-merge steps for a new warp route deployment. Adds the warp route ID to warpIds.ts, updates .registryrc to latest registry commit, runs update-agent-config, then guides the user through warp monitor deployment and PR creation.
---

# Add Warp Route ID

You are completing the post-registry-merge steps for a new warp route deployment.

## Input

The user provides a warp route ID in the format `TOKEN/chain1-chain2` (e.g. `RISE/bsc-ethereum`).

If no warp route ID was provided, ask the user for it now.

---

## Step 1: Derive the Enum Key Name

Convert the warp route ID to a PascalCase TypeScript enum key.

**Pattern** (look at existing entries in `warpIds.ts` for guidance):

- Parse the warp route ID: `TOKEN/chain1-chain2-...`
- Combine chains (PascalCase each segment) + Token: e.g. `RISE/bsc-ethereum` → `BscEthereumRISE`
- For tokens with special casing already used in the file (e.g. `stHYPER`, `Re7LRT`), preserve it
- Check existing entries in `typescript/infra/config/environments/mainnet3/warp/warpIds.ts` to find the closest analogous pattern

Examples from the file:

- `stHYPER = 'stHYPER/bsc-ethereum'` — token-only key when token is distinctive
- `ArbitrumTIA = 'TIA/arbitrum'` — chain(s) + token
- `BscHyperevmEnzoBTC = 'enzoBTC/bsc-hyperevm'` — chains + token
- `EthereumVanaVANA = 'VANA/ethereum-vana'` — chains + token

For `RISE/bsc-ethereum`, the key would be `BscEthereumRISE`.

Confirm the derived key name makes sense before proceeding.

---

## Step 2: Add Entry to warpIds.ts

File: `typescript/infra/config/environments/mainnet3/warp/warpIds.ts`

1. Read the current file
2. Add the new enum entry in an appropriate location (group with related routes if there's a logical section; otherwise append before the closing `}`)
3. Use the format: `EnumKeyName = 'TOKEN/chains',`

Example addition for `RISE/bsc-ethereum`:

```typescript
  BscEthereumRISE = 'RISE/bsc-ethereum',
```

After editing, show the user the added line and confirm the file looks correct.

---

## Step 3: Update .registryrc to Latest Registry Commit

File: `.registryrc` (repo root)

Get the latest commit hash from the hyperlane-registry `main` branch:

```bash
git ls-remote https://github.com/hyperlane-xyz/hyperlane-registry.git HEAD | awk '{print $1}'
```

Update `.registryrc` with the new commit hash (single line, no trailing newline issues — match the current format exactly).

Show the user the old and new commit hash before writing.

---

## Step 3b: Verify Local Registry Is Up To Date

Before running `update-agent-config`, check that the local `hyperlane-registry` clone is present and on the latest `main` commit. The registry must be cloned next to the monorepo (i.e. `../hyperlane-registry` relative to the monorepo root).

```bash
MONOREPO_DIR=$(pwd)  # should be the hyperlane-monorepo root
REGISTRY_PATH="$(dirname $MONOREPO_DIR)/hyperlane-registry"

if [ ! -d "$REGISTRY_PATH" ]; then
  echo "❌ Local registry not found at $REGISTRY_PATH"
  echo "Please clone it: git clone https://github.com/hyperlane-xyz/hyperlane-registry.git $REGISTRY_PATH"
  exit 1
fi

LOCAL_COMMIT=$(git -C "$REGISTRY_PATH" rev-parse HEAD)
REMOTE_COMMIT=$(git ls-remote https://github.com/hyperlane-xyz/hyperlane-registry.git HEAD | awk '{print $1}')

echo "Local registry HEAD:  $LOCAL_COMMIT"
echo "Remote registry HEAD: $REMOTE_COMMIT"

if [ "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ]; then
  echo "⚠️  Local registry is not up to date."
else
  echo "✅ Local registry is up to date."
fi
```

**If the local registry is behind:**

- Stop and tell the user: "Your local `hyperlane-registry` is not on the latest `main` commit. Please run `git -C <path> pull` before continuing, otherwise `update-agent-config` may fail due to missing chain configs."
- Wait for the user to confirm they have updated it before proceeding.

---

## Step 4: Run update-agent-config

From the monorepo root, run:

```bash
pnpm -C typescript/infra run update-agent-config:mainnet3
```

This script regenerates agent configuration files based on the updated registry. It may take a minute.

- Stream/show the output to the user
- If it fails, show the error and stop — do not proceed until the user resolves it
- On success, confirm it completed

---

## Step 5: Deploy Warp Monitor

Run directly from the `typescript/infra` directory (requires helm and kubectl). Pass `--registry-commit` and `--yes` to run non-interactively:

```bash
pnpm tsx ./scripts/warp-routes/deploy-warp-monitor.ts -e mainnet3 --warpRouteId <WARP_ROUTE_ID> --registry-commit <REGISTRY_COMMIT> --yes
```

Use the registry commit hash from Step 3 as `<REGISTRY_COMMIT>`.

- Show the full output to the user
- If it fails, surface the error and stop

---

## Step 5b: Check Warp Monitor Pod Status

Run directly from the `typescript/infra` directory:

```bash
pnpm tsx ./scripts/warp-routes/status.ts --warpRouteId <WARP_ROUTE_ID> -e mainnet3
```

Run from the `typescript/infra` directory.

**Analyze the output yourself:**

- Look for the pod status (e.g. `Running`, `Pending`, `CrashLoopBackOff`, `Error`)
- Check that the warp route ID appears in the output and is recognized
- Check for any error messages or missing configuration
- A healthy deployment shows the pod in `Running` state with no errors

**The pod may take 1-2 minutes to reach `Running` state after deploy.** If the status shows `Pending`, `ContainerCreating`, or `CreateContainerConfigError` on the first check, wait 60 seconds and re-run the status check before treating it as a failure.

If still not running after 2 minutes, diagnose with `kubectl describe pod <pod-name> -n mainnet3` and surface the events to the user.

If healthy, summarize the status and proceed to Step 6. If not, explain what's wrong and wait for the user to resolve it.

---

## Step 6: Prompt User — Create PR

Tell the user:

> The monorepo changes are ready for a PR. The changes include:
>
> - `typescript/infra/config/environments/mainnet3/warp/warpIds.ts` — new enum entry
> - `.registryrc` — updated registry commit hash
> - Any files modified by `update-agent-config` (agent config JSONs)
>
> Please create a PR for these changes. Suggested branch name: `<your-name>/add-warp-route-<token>-<chains>` (e.g. `troy/add-warp-route-rise-bsc-ethereum`).
>
> If you'd like me to create the PR, say "create the PR" and I will run `gh pr create` for you.

If the user asks Claude to create the PR, use `gh pr create` with an appropriate title and body describing the warp route addition.

---

## Notes

- The `update-agent-config` script reads `.registryrc` to determine which registry version to use, so updating `.registryrc` first is required
- Do not skip steps — each depends on the previous
- If any step fails, surface the error clearly and wait for user input
