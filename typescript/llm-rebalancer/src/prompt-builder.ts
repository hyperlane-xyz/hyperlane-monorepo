/**
 * Builds the AGENTS.md system prompt from config + strategy + context.
 */

import type {
  ChainConfig,
  RebalancerAgentConfig,
  StrategyDescription,
} from './config.js';

function formatChainTable(chains: Record<string, ChainConfig>): string {
  const rows = Object.entries(chains).map(
    ([name, c]) =>
      `| ${name} | ${c.domainId} | ${c.warpToken} | ${c.collateralToken} | ${c.bridge} | ${c.mailbox} |`,
  );
  return [
    '| Chain | Domain | Warp Token | Collateral | Bridge | Mailbox |',
    '|-------|--------|------------|------------|--------|---------|',
    ...rows,
  ].join('\n');
}

function formatStrategy(strategy: StrategyDescription): string {
  let base: string;

  if (strategy.type === 'prose') {
    base = strategy.text;
  } else if (strategy.type === 'weighted') {
    const lines = Object.entries(strategy.chains).map(
      ([chain, s]) =>
        `- **${chain}**: target ${(s.weight * 100).toFixed(0)}% of total supply, tolerance ±${(s.tolerance * 100).toFixed(0)}%`,
    );
    base = [
      'Maintain the following weighted distribution of collateral:',
      '',
      ...lines,
      '',
      "If a chain's share deviates beyond its tolerance band, rebalance to bring it back to the target weight.",
    ].join('\n');
  } else {
    // minAmount
    const lines = Object.entries(strategy.chains).map(
      ([chain, s]) =>
        `- **${chain}**: minimum ${s.min} tokens, target ${s.target} tokens (${s.amountType})`,
    );
    base = [
      'Maintain minimum collateral amounts on each chain:',
      '',
      ...lines,
      '',
      'If a chain falls below its minimum, rebalance from surplus chains to bring it to the target.',
    ].join('\n');
  }

  if (strategy.routeHints) {
    base += '\n\n### Route Hints\n\n' + strategy.routeHints;
  }
  if (strategy.policyProse) {
    base += '\n\n### Policy\n\n' + strategy.policyProse;
  }
  return base;
}

function formatAssets(chains: Record<string, ChainConfig>): string {
  const hasAssets = Object.values(chains).some((c) => c.assets);
  if (!hasAssets) return '';

  const lines: string[] = [
    '',
    '### Multi-Asset Deployments',
    '',
    '| Chain | Asset | Warp Token | Collateral | Bridge |',
    '|-------|-------|------------|------------|--------|',
  ];

  for (const [name, chain] of Object.entries(chains)) {
    if (chain.assets) {
      for (const [symbol, asset] of Object.entries(chain.assets)) {
        lines.push(
          `| ${name} | ${symbol} | ${asset.warpToken} | ${asset.collateralToken} | ${asset.bridge} |`,
        );
      }
    }
  }

  return lines.join('\n');
}

export function buildAgentsPrompt(
  config: RebalancerAgentConfig,
  strategy: StrategyDescription,
  previousContext?: string | null,
): string {
  const contextSection = previousContext
    ? `## Previous Context

The following is your summary from the last invocation. Use it to track pending actions and state.

${previousContext}

`
    : '';

  const hasMultiAsset = Object.values(config.chains).some((c) => c.assets);

  const multiAssetSection = hasMultiAsset
    ? `
## Multi-Asset Rebalancing

Each asset is an independent liquidity pool. \`get_balances\` returns per-asset totals/shares.
Strategy keys are \`SYMBOL|chain\` — evaluate each independently.

### Terminology
- **Router collateral**: tokens held by warp token contracts. Shown by \`get_balances\`. Backs user transfers.
- **Wallet inventory**: tokens in your wallet. Shown by \`get_inventory\`. Available for supplying to routers.

### Priority Order
1. **DEPLETED assets** (totalBalance=0) — block ALL pending transfers for that asset. Highest priority.
2. **Cross-asset pending transfers** — a USDC→USDT transfer needs **USDT** collateral on dest chain, not USDC.
3. **Same-asset distribution imbalance** — surplus on one chain, deficit on another.
A DEPLETED asset means system is NOT balanced — do NOT save status=balanced.

### Tools
- \`rebalance_collateral\` — move router collateral directly between chains (same-asset). **Preferred** for distribution imbalances when surplus exists elsewhere.
- \`supply_collateral\` — supply collateral to a router from your wallet inventory (same-asset). Use when router collateral is depleted or insufficient. Specify source (where your wallet has tokens) and destination (which router needs collateral).
- \`get_inventory\` — check your wallet balances before supplying.
- Inventory bridge skills (if available) — convert between assets in your wallet. Check \`.pi/skills/\` for available bridges.

### Decision Tree
1. Same-asset surplus on another chain? → \`rebalance_collateral\` (direct, preferred)
2. Wallet has the right asset? → \`supply_collateral\` (from wallet to router)
3. Need a different asset? → Use inventory bridge skill to convert, then \`supply_collateral\`

`
    : '';

  return `# Warp Route Rebalancer

**BE EXTREMELY TERSE. No narration, no markdown tables, no status reports. Call tools immediately. Minimize text output.**

## Config

${formatChainTable(config.chains)}
${formatAssets(config.chains)}

Rebalancer: \`${config.rebalancerAddress}\`

${contextSection}## Strategy

${formatStrategy(strategy)}
${multiAssetSection}
## Skills

Inventory bridge skills (for cross-asset conversion) are in \`.pi/skills/\`. Read them when you need to convert between assets in your wallet (e.g., swap USDC for USDT via LiFi, then \`supply_collateral\`).
For standard operations (same-asset rebalance, supplying collateral), use \`rebalance_collateral\` and \`supply_collateral\` tools directly.

## Loop

1. Check previous context for pending actions. If pending, use \`check_hyperlane_delivery\` to verify.
2. \`get_balances\` and \`get_pending_transfers\` (call in parallel). Check:
   a. For each pending transfer: the DESTINATION ASSET's collateral on the destination chain must be >= the pending amount. Match by asset (e.g., USDC→USDT transfer needs USDT collateral). If insufficient, BLOCKED — act on that specific asset.
   b. If any asset is DEPLETED (totalBalance=0), NOT balanced — supply collateral from inventory.
   c. Weights within tolerance for all assets.
   Only if ALL pass → \`save_context\` with status=balanced.
3. If imbalanced: use \`rebalance_collateral\` (preferred for same-asset surplus) or \`supply_collateral\` (for depleted assets or when no surplus exists). For cross-asset: use inventory bridge skill first if needed.
4. If action returns a messageId, save it in context for delivery verification.

## Rules

- MUST call \`save_context\` at end of every cycle.
- Never rebalance more than surplus. Account for inflight amounts.
- If action fails, note in context, don't retry immediately.
- Prefer \`rebalance_collateral\` over \`supply_collateral\` (direct router movement > consuming wallet inventory).
- \`save_context\` summary format: FULL messageIds (66 hex chars) for pending. status=balanced or status=pending. Keep under 500 chars. No prose — just facts.
- All amounts are in the token's smallest unit. Check \`get_chain_metadata\` for decimals (e.g., 6 for USDC/USDT, 18 for ETH).
`;
}
