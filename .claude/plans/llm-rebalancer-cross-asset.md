# Multi-Collateral Support for LLM Rebalancer

## Context

LLM rebalancer works for single-asset warp routes (one router per chain). Multi-collateral deployments (MultiCollateral.sol, PR #59) have multiple assets/routers per chain. Goal: (a) sim confirmation via multi-collateral scenarios, (b) production mainnet rebalancing.

Multi-collateral rebalancing is fundamentally harder: the LLM may need to **compose multiple steps** — e.g., bridge USDC chain1→chain2, then swap USDC→USDT on chain2 — because direct routes may not exist. The mock LiFi skill needs route constraints to test this composition.

Much infrastructure already exists — config types, deployment, engine, prompt formatting, strategy keys (`SYMBOL|chain`), ProductionRebalancer tests. The gaps: `get_balances` share calculation, test harness wiring, multi-step prompt guidance, skill separation, route-constrained mock LiFi, and new multi-collateral scenarios.

## Changes

### 1. Fix `get_balances` per-asset output

**`typescript/llm-rebalancer/src/tools/get-balances.ts`**

**Bug**: Lines 82-85 sum only primary warp token balances. Asset balances shown with shares relative to wrong total. Each asset is an independent liquidity pool — needs its own total.

**Fix**: Detect multi-asset deployment (`chain.assets` present on any chain). When multi-asset, restructure output per-asset:

```json
{
  "assets": {
    "USDC": {
      "totalBalance": "200000...",
      "chains": {
        "chain1": { "balance": "100000...", "share": "50%" },
        "chain2": { "balance": "100000...", "share": "50%" }
      }
    },
    "USDT": { "totalBalance": "...", "chains": { ... } }
  }
}
```

For single-asset deployments (no `chain.assets` on any chain), output unchanged — backward compat for existing scenarios. In multi-asset deployments `chain.warpToken == chain.assets[firstAsset].warpToken`, so iterate only `chain.assets` to avoid double-counting.

### 2. New `get_inventory` tool

**`typescript/llm-rebalancer/src/tools/get-inventory.ts`** (new)

Rebalancer wallet's own token balances (not warp collateral). For each chain × each asset, calls `ERC20.balanceOf(rebalancerAddress)` on the collateral token.

```json
{ "chain1": { "USDC": "5000...", "USDT": "0" }, "chain2": { ... } }
```

Wire into `buildCustomTools()`. Single-asset: returns primary collateral balance per chain. Production: tells LLM what it can deposit or bridge.

### 3. Move sim-only skills to rebalancer-sim

**Move**: `llm-rebalancer/skills/rebalance-mock-bridge/` → `rebalancer-sim/skills/rebalance-mock-bridge/`

**`rebalancer-sim/src/runners/LLMRebalancerRunner.ts`**: After copying production skills from llm-rebalancer, also copy sim skills from `rebalancer-sim/skills/`. Add `findSimSkillsDir()`.

**`llm-rebalancer/skills/bridge-tokens/SKILL.md`**: Remove "Simulation Mode" section.

### 4. Route constraints via prose strategy

Instead of a separate tool, communicate available rebalancing routes in the strategy description. This avoids unnecessary LiFi quote calls and gives the LLM clear upfront guidance.

**`typescript/llm-rebalancer/src/config.ts`**: Add optional `routeHints?: string` to `StrategyDescription` (all variants). Appended to strategy output in prompt.

**`typescript/rebalancer-sim/scenarios/*.json`**: Multi-collateral scenarios include route hints in `defaultStrategyConfig`:

```json
{
  "type": "weighted",
  "routeHints": "Available routes:\n- Mock bridge: same-asset cross-chain (USDC chain1↔chain2, USDT chain1↔chain2)\n- Same-chain swap: USDC↔USDT on any chain via MultiCollateral.transferRemoteTo\n- NOT available: direct cross-asset cross-chain (e.g., USDC chain1 → USDT chain2)\nIf you need USDT on chain2 but only have USDC surplus on chain1, compose: bridge USDC chain1→chain2, then swap USDC→USDT on chain2.",
  "chains": { ... }
}
```

**`typescript/llm-rebalancer/src/prompt-builder.ts`**: In `formatStrategy()`, append `routeHints` if present.

For production: route hints describe which LiFi routes are supported (e.g., "Use LiFi for USDC↔USDT swaps. Use warp rebalance for same-asset cross-chain."). This is set by the operator in the config.

### 5. Same-chain asset swap skill

**`typescript/llm-rebalancer/skills/rebalance-same-chain-swap/SKILL.md`** (new)

Swap between assets on the same chain via `MultiCollateral.transferRemoteTo(localDomain, recipient, amount, targetRouter)`. Instant — direct `handle()` call, no mailbox.

Steps:

1. Approve source collateral to source warp token
2. `cast send <sourceWarpToken> 'transferRemoteTo(uint32,bytes32,uint256,bytes32)' <localDomainId> <recipientBytes32> <amount> <targetWarpTokenBytes32>`
3. No messageId (atomic). Save context noting completion.

### 6. Update prompt for multi-asset + multi-step rebalancing

**`typescript/llm-rebalancer/src/prompt-builder.ts`**

Add multi-asset guidance (conditionally when deployment has assets):

```
## Multi-Asset Rebalancing

Each asset is an independent liquidity pool. `get_balances` returns per-asset totals/shares.
Strategy keys are `SYMBOL|chain` — evaluate each independently.

### Available Operations
1. **Same-asset cross-chain**: `rebalance()` via bridge (moves USDC chain1→chain2)
2. **Same-chain asset swap**: `transferRemoteTo(localDomain)` (swaps USDC→USDT on same chain)
3. **Cross-asset cross-chain**: compose steps 1+2 (bridge USDC to chain2, then swap to USDT)

Route availability is described in the Strategy section. If no direct route, compose multiple steps.
Prefer: same-chain swap > single bridge > multi-step composition.

### Pending Transfers
`get_pending_transfers` includes sourceAsset and destinationAsset. A pending cross-asset
transfer (e.g., USDC→USDT) needs the DESTINATION asset's collateral on the target chain.
```

### 7. Update `runScenarioWithRebalancers` for multi-asset

**`typescript/rebalancer-sim/test/utils/simulation-helpers.ts`**

Currently line 153 always calls `deployMultiDomainSimulation()`. When `file.assets` is defined and has entries, call `deployMultiAssetSimulation()` instead. This way multi-collateral scenarios use the same `full-simulation.test.ts` flow — no separate test file needed.

Strategy config builder (lines 193-201): For `SYMBOL|chain` keys, resolve bridge from `domain.assets[symbol].bridge`. Move the existing `resolveBridge()` function from `multi-asset-simulation.test.ts` into `simulation-helpers.ts` as a shared utility.

### 8. Enrich PendingTransfer for cross-asset transfers

**`typescript/llm-rebalancer/src/pending-transfers.ts`**: Expand interface:

```typescript
export interface PendingTransfer {
  messageId: string;
  origin: string;
  destination: string;
  amount: string;
  sourceAsset?: string; // input asset (e.g., USDC)
  destinationAsset?: string; // output asset (e.g., USDT)
  targetRouter?: string; // destination warp token address
}
```

**`rebalancer-sim/src/runners/MockActionTracker.ts`**: Add side-maps for asset metadata per transfer: `transferMeta: Map<string, { sourceAsset?: string, destinationAsset?: string, targetRouter?: string }>`.

**`rebalancer-sim/src/MockInfrastructureController.ts`**: When classifying multi-asset sender (line 140-147 loop), resolve which asset it is. For cross-asset transfers, decode the targetRouter from the message body. Set metadata on actionTracker.

**`rebalancer-sim/src/runners/LLMRebalancerRunner.ts`**: Adapter reads metadata to populate PendingTransfer fields.

### 9. Fix ExplorerPendingTransferProvider for multi-asset

**`typescript/llm-rebalancer/src/explorer-pending-transfers.ts`**

Change `ExplorerClientLike` to accept `routersByDomain: Record<number, string[]>`. Build with ALL asset warp tokens per domain. If underlying explorer only accepts single router, make multiple queries and merge.

### 10. New multi-collateral scenarios

**`typescript/rebalancer-sim/scenarios/`** (new JSON files)

**a. `mc-local-cross-asset-imbalance.json`**
2 chains, 2 assets (USDC, USDT). Transfers drain USDT on chain2 while USDC on chain2 stays balanced. Rebalancer should swap USDC→USDT locally on chain2 (same-chain swap). Tests single-step local swap.

**b. `mc-remote-cross-asset-imbalance.json`**
2 chains, 2 assets. Chain1 has USDC surplus, chain2 has USDT deficit. No direct USDC→USDT cross-chain route. Rebalancer must compose: bridge USDC chain1→chain2, then swap USDC→USDT on chain2. Tests multi-step composition.

**c. `mc-mixed-traffic.json`**
3 chains, 2 assets. Mixed same-asset and cross-asset transfers. Some routes available, some not. Rebalancer must handle multiple imbalance types simultaneously.

Strategy uses `SYMBOL|chain` keys. Route constraints in scenario config tell the mock LiFi which direct routes exist.

### 11. Integrate multi-collateral tests into full-simulation

**`typescript/rebalancer-sim/test/integration/full-simulation.test.ts`**

Add test cases for the new multi-collateral scenarios (mc-local-_, mc-remote-_, mc-mixed-\*) following the same pattern as existing tests. `runScenarioWithRebalancers()` handles multi-asset detection (step 7), so these are just new `it()` blocks that call `runScenarioWithRebalancers('mc-local-cross-asset-imbalance', { anvilRpc })`.

### 12. Visualizer per-asset dimension (defer)

Lower priority. KPI numbers are still correct without it. Would need: KPICollector tracking per `SYMBOL|chain`, balance timeline keyed by `SYMBOL|chain`, HTML grouping by asset.

## Files

| Action | File                                                                      |
| ------ | ------------------------------------------------------------------------- |
| Modify | `llm-rebalancer/src/tools/get-balances.ts`                                |
| New    | `llm-rebalancer/src/tools/get-inventory.ts`                               |
| Modify | `llm-rebalancer/src/tools/index.ts`                                       |
| Modify | `llm-rebalancer/src/config.ts`                                            |
| Move   | `llm-rebalancer/skills/rebalance-mock-bridge/` → `rebalancer-sim/skills/` |
| Modify | `llm-rebalancer/skills/bridge-tokens/SKILL.md`                            |
| New    | `llm-rebalancer/skills/rebalance-same-chain-swap/SKILL.md`                |
| Modify | `llm-rebalancer/src/explorer-pending-transfers.ts`                        |
| Modify | `llm-rebalancer/src/pending-transfers.ts`                                 |
| Modify | `llm-rebalancer/src/prompt-builder.ts`                                    |
| Modify | `llm-rebalancer/src/index.ts`                                             |
| Modify | `rebalancer-sim/src/runners/LLMRebalancerRunner.ts`                       |
| Modify | `rebalancer-sim/test/utils/simulation-helpers.ts`                         |
| Modify | `rebalancer-sim/test/integration/full-simulation.test.ts`                 |
| Modify | `rebalancer-sim/src/runners/MockActionTracker.ts`                         |
| Modify | `rebalancer-sim/src/MockInfrastructureController.ts`                      |
| New    | `rebalancer-sim/scenarios/mc-local-cross-asset-imbalance.json`            |
| New    | `rebalancer-sim/scenarios/mc-remote-cross-asset-imbalance.json`           |
| New    | `rebalancer-sim/scenarios/mc-mixed-traffic.json`                          |

## Implementation order

1. `get_balances` per-asset fix + `get_inventory` tool (steps 1-2)
2. Move sim skills + LLMRebalancerRunner skill injection (step 3)
3. Route hints in config/strategy + same-chain swap skill (steps 4-5)
4. Prompt multi-asset + multi-step guidance (step 6)
5. `runScenarioWithRebalancers` multi-asset detection (step 7)
6. PendingTransfer enrichment (step 8)
7. Explorer multi-asset fix (step 9)
8. New scenarios (step 10)
9. Integration tests in full-simulation.test.ts (step 11)
10. Verify all existing single-asset tests still pass

## Verification

```bash
pnpm -C typescript/llm-rebalancer build
pnpm -C typescript/rebalancer-sim build

# Existing single-asset (no regression)
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "extreme-drain"
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "blocked-user-transfer"

# Multi-collateral scenarios
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "mc-local"
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "mc-remote"
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "mc-mixed"

# ProductionRebalancer multi-asset (no regression)
pnpm -C typescript/rebalancer-sim test --grep "multi-asset"
```
