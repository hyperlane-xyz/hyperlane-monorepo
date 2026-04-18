---
name: warp-deploy-register-route
description: Post-registry-merge steps for a new warp route deployment. Adds the warp route ID to warpIds.ts, updates .registryrc to latest registry commit, runs update-agent-config, then guides the user through warp monitor deployment and PR creation.
---

# Add Warp Route ID

You are completing the post-registry-merge steps for a new warp route deployment.

## Input

The user provides one or more warp route IDs in the format `TOKEN/chain` (stable ID — just the primary new/synthetic chain), and/or one or more Linear ticket URLs. Multiple routes can be batched into a single PR.

If Linear ticket URL(s) are provided, fetch each ticket to extract the warp route ID and route details. Look for fields like "Route Type", "Connected Chains", and notes about ownership/ICA.

If no warp route ID was provided, ask the user for it now.

**When multiple routes are provided**, process Steps 1–5 for each route independently (each gets its own enum entry and warp monitor), then create a single combined PR in Step 6 that covers all routes.

---

## Detecting Route Type: Simple vs. Multi-Collateral

Before proceeding, classify the route:

**Simple route** — one or two chains, no rebalancing, no ICA ownership:

- Proceed with Steps 1–6 as written below.
- Skip Step 2b entirely.

**Multi-collateral route with rebalancing** — multiple collateral chains + one synthetic, CCTP rebalancing bridges, ICA-based ownership:

- Identifiers: 3+ chains, or Linear ticket says "ICA on all chains", or registry config has `allowedRebalancers`/`allowedRebalancingBridges`.
- Must complete Step 2b (configGetter) in addition to Steps 1–6.

---

---

## Step 1: Derive the Enum Key Name

Convert the warp route ID to a PascalCase TypeScript enum key.

**Pattern** (look at existing entries in `warpIds.ts` for guidance):

- Parse the warp route ID: `TOKEN/chain` (stable format — just the primary new/synthetic chain)
- Combine chain (PascalCase) + Token: e.g. `USDS/igra` → `IgraUSDS`
- For tokens with special casing already used in the file (e.g. `stHYPER`, `Re7LRT`), preserve it
- Check existing entries in `typescript/infra/config/environments/mainnet3/warp/warpIds.ts` to find the closest analogous pattern

Examples from the file:

- `IgraUSDS = 'USDS/igra'` — chain + token (stable single-chain format)
- `IgraWETH = 'WETH/igra'` — chain + token
- `ArbitrumTIA = 'TIA/arbitrum'` — chain + token (older multi-chain format, still valid for existing routes)

For `USDS/igra`, the key would be `IgraUSDS`.

Confirm the derived key name makes sense before proceeding.

---

## Step 2: Add Entry to warpIds.ts

File: `typescript/infra/config/environments/mainnet3/warp/warpIds.ts`

1. Read the current file
2. Add the new enum entry in an appropriate location (group with related routes if there's a logical section; otherwise append before the closing `}`)
3. Use the format: `EnumKeyName = 'TOKEN/chains',`

Example addition for `USDS/igra`:

```typescript
  IgraUSDS = 'USDS/igra',
```

After editing, show the user the added line and confirm the file looks correct.

---

## Step 2b: ConfigGetter (Multi-Collateral Routes Only)

**Skip this step for simple routes.**

Multi-collateral routes with ICA ownership and CCTP rebalancing require a configGetter in addition to the warpIds.ts entry. This enables `warp apply` and ownership management.

### Files to create/modify:

**1. Uncomment warpFees ICA entry (if commented out)**

File: `typescript/infra/config/environments/mainnet3/governance/ica/warpFees.ts`

Check if the synthetic chain is commented out in the warpFees ICA map. If so, uncomment it. The warpFees ICA address is the fee owner for the synthetic token's routing fee contract.

Example — for `USDC/igra`, uncomment:

```typescript
igra: '0x42cb788529463B1F41de9E3cd3d2906930aCd32F',
```

**2. Create the configGetter**

File: `typescript/infra/config/environments/mainnet3/warp/configGetters/get<SyntheticChain><TOKEN>WarpConfig.ts`

Follow the pattern from `getElectroneumUSDCWarpConfig.ts` (simplest multi-collateral example) or `getEclipseUSDCWarpConfig.ts` (advanced with fees + proxy admins).

Key structure:

- `ownersByChain`: hardcode from the deploy YAML's `owner` fields (these are ICA/Safe addresses already set during deployment)
- `collateralChains`: all non-synthetic chains
- `rebalancingConfigByChain`: call `getUSDCRebalancingBridgesConfigFor(collateralChains, [WarpRouteIds.MainnetCCTPV2Standard, WarpRouteIds.MainnetCCTPV2Fast])`
- Each collateral chain: `getRebalancingUSDCConfigForChain(chain, routerConfig, ownersByChain, rebalancingConfigByChain)`
- Synthetic chain: `getSyntheticTokenConfigForChain(...)` + add `tokenFee: getFixedRoutingFeeConfig(getWarpFeeOwner(syntheticChain), collateralChains, bps)` if the deploy YAML shows a `tokenFee`

Also export `get<Name>StrategyConfig` for ICA-based `warp apply`:

- `ORIGIN_CHAIN = 'ethereum'`
- `safeAddress` = `ownersByChain.ethereum` (the ethereum Safe that controls all ICAs)
- All non-ethereum chains get `TxSubmitterType.INTERCHAIN_ACCOUNT` submitters routing through the ethereum Safe

```typescript
export const get<Name>StrategyConfig = (): ChainSubmissionStrategy => {
  const safeAddress = ownersByChain[ORIGIN_CHAIN];
  const originSafeSubmitter = { type: TxSubmitterType.GNOSIS_SAFE, chain: ORIGIN_CHAIN, safeAddress };
  const chainAddress = getChainAddresses();
  const originInterchainAccountRouter = chainAddress[ORIGIN_CHAIN].interchainAccountRouter;
  assert(originInterchainAccountRouter, ...);
  const icaChains = [...collateralChains, syntheticChain].filter(c => c !== ORIGIN_CHAIN);
  const icaStrategies = icaChains.map(chain => [chain, { submitter: {
    type: TxSubmitterType.INTERCHAIN_ACCOUNT, chain: ORIGIN_CHAIN, destinationChain: chain,
    owner: safeAddress, originInterchainAccountRouter, internalSubmitter: originSafeSubmitter,
  }}]);
  return Object.fromEntries([[ORIGIN_CHAIN, { submitter: originSafeSubmitter }], ...icaStrategies]);
};
```

**3. Register in config/warp.ts**

File: `typescript/infra/config/warp.ts`

Add the import and register in both maps:

```typescript
import { get<Name>StrategyConfig, get<Name>WarpConfig } from './environments/mainnet3/warp/configGetters/get<Name>WarpConfig.js';

// in warpConfigGetterMap:
[WarpRouteIds.<EnumKey>]: get<Name>WarpConfig,

// in strategyConfigGetterMap:
[WarpRouteIds.<EnumKey>]: get<Name>StrategyConfig,
```

After writing, run `pnpm -C typescript/infra tsc --noEmit --skipLibCheck` to verify no type errors.

**4. Create rebalancer config**

File: `typescript/infra/config/environments/mainnet3/rebalancer/<TOKEN>/<label>-config.yaml`

Where `<label>` is the part of the warp route ID after the `/` (e.g. `USDC/igra` → `igra-config.yaml`).

Use the **weighted** strategy for most routes. Weights come from the Linear ticket notes (e.g. "35% ethereum, 20% arb, ..."). Bridge addresses are the **CCTP V2 Standard** bridge contracts per chain — find these in the `allowedRebalancingBridges` field of the deploy YAML (first bridge listed per destination pair).

```yaml
warpRouteId: TOKEN/label

strategy:
  rebalanceStrategy: weighted
  chains:
    ethereum:
      weighted:
        weight: 35 # from Linear ticket weights
        tolerance: 5
      bridgeLockTime: 1800 # 30 mins for CCTP
      bridgeMinAcceptedAmount: 1000
      bridge: '0x...' # CCTP V2 Standard bridge on this chain

    arbitrum:
      weighted:
        weight: 20
        tolerance: 5
      bridgeLockTime: 1800
      bridgeMinAcceptedAmount: 1000
      bridge: '0x...'
    # ... repeat for all collateral chains
```

Common CCTP V2 Standard bridge addresses (verify against deploy YAML):

- `ethereum`: `0x8c8D831E1e879604b4B304a2c951B8AEe3aB3a23`
- `arbitrum`: `0x4c19c653a8419A475d9B6735511cB81C15b8d9b2`
- `base`, `optimism`, `polygon`, `avalanche`: `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a`

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

## Step 6: Create PR

Create the monorepo PR directly using `gh pr create`. First check out a branch:

```bash
git checkout -b <your-name>/add-warp-route-<token>-<chains>
```

Then stage and commit all changed files (warpIds.ts, .registryrc, agent config JSONs, and for multi-collateral: warpFees.ts, configGetter, warp.ts, rebalancer config):

```bash
git add typescript/infra/config/environments/mainnet3/warp/warpIds.ts
git add .registryrc
git add typescript/infra/config/environments/mainnet3/
git add typescript/infra/config/warp.ts
git commit -m "feat: add <TOKEN>/<chain1>-<chain2> warp route"
git push -u origin HEAD
```

Then open the PR:

```bash
gh pr create \
  --title "feat: add <TOKEN>/<chain1>-<chain2> warp route" \
  --body "$(cat <<'EOF'
## Summary

Adds the `<TOKEN>/<chain1>-<chain2>` warp route to the monorepo.

| Field | Value |
| ----- | ----- |
| **Linear** | <linear-issue-url> |
| **Warp route ID** | `<TOKEN>/<chain1>-<chain2>` |
| **Warp monitor** | [Grafana](https://abacusworks.grafana.net/d/ddz6ma94rnzswc/warp-routes?orgId=1&var-warp_route_id=<URL-encoded-warp-route-id>) |

## Changes

- `typescript/infra/config/environments/mainnet3/warp/warpIds.ts` — new `<EnumKey>` enum entry
- `.registryrc` — updated to registry commit `<commit-hash>`
- Agent config JSONs updated by `update-agent-config`

**Multi-collateral routes also include:**

- `typescript/infra/config/environments/mainnet3/governance/ica/warpFees.ts` — uncommented `<synthetic-chain>` entry
- `typescript/infra/config/environments/mainnet3/warp/configGetters/get<Name>WarpConfig.ts` — new configGetter
- `typescript/infra/config/warp.ts` — new import + map entries
- `typescript/infra/config/environments/mainnet3/rebalancer/<TOKEN>/<label>-config.yaml` — rebalancer config

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in real values:

- `<linear-issue-url>`: full Linear ticket URL(s). If multiple routes, list each on its own row in the table, e.g.:
  ```
  | **Linear** | [AW-548](...) · [AW-551](...) |
  ```
- Grafana URL: URL-encode the warp route ID (replace `/` with `%2F`, e.g. `RISE%2Fbsc-ethereum`). If multiple routes, list each on its own row.
- `<commit-hash>`: the registry commit hash written to `.registryrc` in Step 3
- Omit the multi-collateral section if all routes are simple routes
- When batching multiple routes, repeat the warp route ID + Grafana rows for each route and list all changed files

Show the user the PR URL when done.

---

## Notes

- The `update-agent-config` script reads `.registryrc` to determine which registry version to use, so updating `.registryrc` first is required
- Do not skip steps — each depends on the previous
- If any step fails, surface the error clearly and wait for user input
