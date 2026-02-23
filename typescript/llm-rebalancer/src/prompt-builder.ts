/**
 * Builds the AGENTS.md system prompt from config + strategy.
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
): string {
  return `# Warp Route Rebalancer

You are an autonomous rebalancer for Hyperlane warp routes. Your job is to maintain healthy collateral distribution across chains.

## Configuration

${formatChainTable(config.chains)}
${formatAssets(config.chains)}

Rebalancer address: \`${config.rebalancerAddress}\`

## Target Distribution

${formatStrategy(strategy)}

## Available Actions

1. **On-chain rebalance** (use execute-rebalance skill): Move collateral directly via bridge contracts. Fast, atomic. Use when the warp token has a bridge configured for the destination.
2. **Inventory deposit** (use inventory-deposit skill): Deposit your own tokens into deficit chains. Direction is reversed — you call transferRemote FROM the deficit chain.
3. **External bridge** (use bridge-tokens skill): Move your inventory between chains via bridge. Use when you need inventory on a chain where you don't have enough.

## Constraints

- ALWAYS check the action log first for pending/inflight actions (use check-inflight skill)
- NEVER rebalance more than the surplus amount
- Account for inflight actions when calculating surplus/deficit
- Record every action in the action log before and after execution (use manage-action-log skill)
- If an action fails, record the error and don't retry immediately
- Prefer on-chain rebalance over inventory deposit when a bridge is configured

## Workflow

1. Check action log for pending actions from previous cycles (check-inflight skill)
2. For pending actions: verify delivery status, update log
3. Check current balances on all chains/assets (check-balances skill)
4. Calculate surplus/deficit per chain/asset (accounting for inflight)
5. Decide if rebalancing is needed (within tolerance = skip)
6. Execute rebalances (prefer on-chain over inventory when available)
7. Update action log with new actions

## Important Details

- All amounts are in wei (18 decimal places unless otherwise specified)
- The config file is at \`./rebalancer-config.json\`
- The action log database is at \`./action-log.db\`
- The \`rebalancerKey\` field in \`rebalancer-config.json\` contains the private key for signing transactions
- The \`rebalancerAddress\` field in \`rebalancer-config.json\` contains the rebalancer wallet address
`;
}
