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

### PRIORITY ORDER — handle in this exact order:
1. **DEPLETED assets FIRST** (totalBalance=0) — see below. These block all pending transfers that need them.
2. **Cross-asset pending transfers** — check \`destinationAsset\` on each pending transfer. That asset's collateral must be sufficient on the destination chain.
3. **Same-asset distribution imbalance** — standard \`rebalance()\` via bridge.

### Depleted Assets (HIGHEST PRIORITY)
If \`get_balances\` shows an asset with totalBalance=0 (status: DEPLETED):
- \`warp.rebalance()\` CANNOT help — no collateral exists to bridge
- You MUST use the \`inventory-deposit\` skill: call \`bridge.transferRemote()\` DIRECTLY (not through warp)
- **Amount**: sum ALL pending transfers where \`destinationAsset\` matches the depleted asset. Each such transfer needs that much collateral on its destination chain.
- **A DEPLETED asset means the system is NOT balanced — do NOT save status=balanced.**

### Cross-Asset Pending Transfers (CRITICAL)
\`get_pending_transfers\` shows \`sourceAsset\` and \`destinationAsset\`. When these differ (e.g., USDC→USDT):
- The transfer needs **destinationAsset** (USDT) collateral on the target chain, NOT sourceAsset (USDC).
- Check: does the destination chain's warp token for the **destinationAsset** have enough collateral?
- If not, you must add collateral for the **destinationAsset** (via bridge or inventory-deposit).
**Common mistake**: seeing "pending USDC→USDT" and checking USDC collateral. You must check USDT collateral.

### Available Operations
1. **Same-asset cross-chain**: \`rebalance()\` via bridge (moves USDC chain1→chain2)
2. **Inventory deposit**: \`bridge.transferRemote()\` directly for depleted assets (see \`inventory-deposit\` skill)
3. **Same-chain asset swap**: \`transferRemoteTo(localDomain)\` (swaps USDC→USDT on same chain, only if destination has collateral)

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

Rebalance skills are in \`.pi/skills/\`. Read the appropriate one when you first need to execute a rebalance.
After the first rebalance, save a \`tpl:\` field in context with the command template (placeholders for addresses/amounts). On subsequent cycles, use the template + \`get_chain_metadata\` — skip re-reading the skill.

## Loop

1. Check previous context for pending actions. If pending, use \`check_hyperlane_delivery\` to verify.
2. \`get_balances\` and \`get_pending_transfers\` (call in parallel). Check three conditions:
   a. For each pending transfer: the DESTINATION ASSET's collateral on the destination chain must be >= the pending amount. Match by asset (e.g., USDC→USDT transfer needs USDT collateral). If insufficient, BLOCKED — rebalance that specific asset.
   b. If any asset is DEPLETED (totalBalance=0), NOT balanced — deposit from inventory (see Depleted Assets).
   c. Weights within tolerance for all assets.
   Only if ALL three pass → \`save_context\` with status=balanced.
3. If imbalanced and context has \`tpl:\` → use template with \`get_chain_metadata\` to build command. Otherwise read the appropriate skill from \`.pi/skills/\`.
4. Execute rebalance, extract messageId, \`save_context\` with status=pending.

## Rules

- MUST call \`save_context\` at end of every cycle.
- Never rebalance more than surplus. Account for inflight amounts.
- If action fails, note in context, don't retry immediately.
- Prefer on-chain rebalance over inventory deposit.
- \`save_context\` summary format: \`tpl:\` with cast send template (use <SOURCE_WARP> <DEST_DOMAIN> <AMOUNT> <BRIDGE> <RPC> as placeholders). FULL messageIds (66 hex chars) for pending. Keep under 500 chars. No prose — just facts.
- All amounts in wei (18 decimals).
`;
}
