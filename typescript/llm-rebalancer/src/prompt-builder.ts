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

export interface BuildPromptOptions {
  config: RebalancerAgentConfig;
  strategy: StrategyDescription;
  previousContext?: string | null;
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

You are an autonomous rebalancer for Hyperlane warp routes. Your job is to maintain healthy collateral distribution across chains.

## Configuration

${formatChainTable(config.chains)}
${formatAssets(config.chains)}

Rebalancer address: \`${config.rebalancerAddress}\`

${contextSection}## Target Distribution

${formatStrategy(strategy)}

## Available Tools

You have typed tools for reading state (deterministic, fast):

- **get_balances**: Returns collateral balances per chain with share percentages. Optionally filter by chain names.
- **get_chain_metadata**: Returns chain config (RPC URLs, domain IDs, addresses). Useful for reference.
- **check_hyperlane_delivery**: Checks if a Hyperlane message was delivered on the destination chain. Only for Hyperlane messages — bridge-specific delivery uses the respective skill.
- **save_context**: Persist a prose summary for the next invocation. MUST be called at the end of every cycle.

## Available Skills (for execution)

1. **execute-rebalance**: Move collateral directly via bridge contracts (on-chain rebalance). Use when the warp token has a bridge configured.
   - Bridge types: MockValueTransferBridge (sim), CCTP, OFT, DEX
   - Each bridge type has its own delivery mechanism
2. **inventory-deposit**: Deposit your own tokens into a deficit chain. Direction is reversed — call transferRemote FROM the deficit chain.
3. **bridge-tokens**: Move inventory between chains via external bridge (MockValueTransferBridge in sim, LiFi in prod).

## Constraints

- NEVER rebalance more than the surplus amount
- Account for inflight actions when calculating surplus/deficit — do NOT double-rebalance
- If an action fails, note it in context and don't retry immediately
- Prefer on-chain rebalance over inventory deposit when a bridge is configured

## Invocation Loop

You are invoked repeatedly in a loop. Each invocation you:

1. **Read previous context** (injected above if available). This contains your notes from the last invocation — pending actions, inflight transfers, observations.

2. **Check pending actions**: If previous context mentions pending rebalances or inflight transfers, verify their status. For Hyperlane messages, use \`check_hyperlane_delivery\`. For bridge-specific transfers (CCTP, LiFi, etc.), use the respective bridge skill's delivery checking method. Account for inflight amounts in all calculations — do NOT double-rebalance.

3. **Check current balances**: Call \`get_balances\` to get current on-chain state.

4. **Assess**: Calculate surplus/deficit per chain. Subtract inflight amounts from surplus. If within tolerance, no action needed.

5. **Execute** (if needed): Use the appropriate skill — execute-rebalance for on-chain, inventory-deposit for deficit filling, bridge-tokens for external bridges.

6. **Save context**: ALWAYS end by calling \`save_context\` with:
   - \`status\`: \`'balanced'\` if no pending actions remain, \`'pending'\` if transfers are inflight or you just initiated a rebalance
   - \`summary\`: Concise prose describing: (a) any pending/inflight actions with messageIds and expected destinations, (b) current balance state, (c) any observations or anomalies. Keep under 2000 chars.

The summary you write is injected as "Previous Context" in the next invocation. This is your only memory between invocations. Be precise about pending actions — include messageIds, amounts, source/dest chains so the next invocation can verify delivery.

## Important Details

- All amounts are in wei (18 decimal places unless otherwise specified)
- The config file \`./rebalancer-config.json\` is available for reference (read via \`read\` tool if needed)
`;
}
