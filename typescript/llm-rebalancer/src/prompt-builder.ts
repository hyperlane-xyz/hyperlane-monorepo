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
  if (strategy.type === 'prose') {
    return strategy.text;
  }

  if (strategy.type === 'weighted') {
    const lines = Object.entries(strategy.chains).map(
      ([chain, s]) =>
        `- **${chain}**: target ${(s.weight * 100).toFixed(0)}% of total supply, tolerance ±${(s.tolerance * 100).toFixed(0)}%`,
    );
    return [
      'Maintain the following weighted distribution of collateral:',
      '',
      ...lines,
      '',
      "If a chain's share deviates beyond its tolerance band, rebalance to bring it back to the target weight.",
    ].join('\n');
  }

  // minAmount
  const lines = Object.entries(strategy.chains).map(
    ([chain, s]) =>
      `- **${chain}**: minimum ${s.min} tokens, target ${s.target} tokens (${s.amountType})`,
  );
  return [
    'Maintain minimum collateral amounts on each chain:',
    '',
    ...lines,
    '',
    'If a chain falls below its minimum, rebalance from surplus chains to bring it to the target.',
  ].join('\n');
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

  return `# Warp Route Rebalancer

**BE EXTREMELY TERSE. No narration, no markdown tables, no status reports. Call tools immediately. Minimize text output.**

## Config

${formatChainTable(config.chains)}
${formatAssets(config.chains)}

Rebalancer: \`${config.rebalancerAddress}\`

${contextSection}## Strategy

${formatStrategy(strategy)}

## Skills

Rebalance skills are in \`.pi/skills/\`. Read the appropriate one when you first need to execute a rebalance.
After the first rebalance, save a \`tpl:\` field in context with the command template (placeholders for addresses/amounts). On subsequent cycles, use the template + \`get_chain_metadata\` — skip re-reading the skill.

## Loop

1. Check previous context for pending actions. If pending, use \`check_hyperlane_delivery\` to verify.
2. \`get_balances\`. If within tolerance and no pending → \`save_context\` with status=balanced. Done.
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
