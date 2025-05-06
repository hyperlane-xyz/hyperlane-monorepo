import lowUrgencyKeyFunderBalance from '../../config/environments/mainnet3/balances/lowUrgencyKeyFunderBalance.json' with { type: 'json' };
import targetDollarBalances from '../../config/environments/mainnet3/balances/target-dollar-balances.json' with { type: 'json' };
import { mainnet3SupportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import tokenPrices from '../../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };

type ChainName = keyof typeof targetDollarBalances;

// Get chains from targetDollarBalances
const CHAINS = Object.keys(targetDollarBalances) as ChainName[];

// Validate that all CHAINS are in mainnet3SupportedChainNames
const unsupportedChains = CHAINS.filter(
  (chain) => !mainnet3SupportedChainNames.includes(chain),
);
if (unsupportedChains.length > 0) {
  console.error(
    `Error: The following chains are not in mainnet3SupportedChainNames:\n${unsupportedChains.join('\n')}`,
  );
  process.exit(1);
}

interface ChainBalanceInfo {
  chain: ChainName;
  symbol: string;
  tokenPrice: number;
  balance: number;
  dollarValue: number;
  targetDollarValue: number;
  percentageOfTarget: number;
  excessFunding: number;
}

function processChains(
  chains: readonly ChainName[],
  balances: Record<ChainName, number>,
): ChainBalanceInfo[] {
  const results: ChainBalanceInfo[] = [];

  for (const chain of chains) {
    const tokenPrice = Number(tokenPrices[chain as keyof typeof tokenPrices]);
    if (!tokenPrice) {
      console.error(`No token price found for ${chain}`);
      continue;
    }

    const balance = balances[chain];
    const dollarValue = balance * tokenPrice;
    const targetDollarValue =
      targetDollarBalances[chain as keyof typeof targetDollarBalances];
    const percentageOfTarget =
      targetDollarValue > 0 ? (dollarValue / targetDollarValue) * 100 : 0;
    const excessFunding = Math.max(0, dollarValue - targetDollarValue);

    results.push({
      chain,
      symbol: chain.toUpperCase(),
      tokenPrice,
      balance,
      dollarValue,
      targetDollarValue,
      percentageOfTarget,
      excessFunding,
    });
  }

  return results;
}

async function main() {
  const balances = lowUrgencyKeyFunderBalance as Record<ChainName, number>;
  const results = processChains(CHAINS, balances);

  // Sort results by percentage of target (descending) to show most overfunded first
  results.sort((a, b) => b.percentageOfTarget - a.percentageOfTarget);

  // Build output string
  let output = '\nChain Balance Report\n==================\n';
  output += '\nChains Above Target Balance (ERROR):\n';

  for (const result of results) {
    if (result.dollarValue > result.targetDollarValue) {
      output += `\n🔴 ${result.chain.padEnd(15)} (${result.symbol})`;
      output += `\n   Alerting balance: ${result.balance.toFixed(6)} ${result.symbol} ($${result.dollarValue.toFixed(2)})`;
      output += `\n   Target: $${result.targetDollarValue.toFixed(2)}`;
      output += `\n   Current: ${result.percentageOfTarget.toFixed(1)}% of target`;
      output += `\n   Excess: $${result.excessFunding.toFixed(2)} above target`;
      output += '\n';
    }
  }

  output += '\nChains At or Below Target Balance:\n';
  for (const result of results) {
    if (result.dollarValue <= result.targetDollarValue) {
      output += `\n✅ ${result.chain.padEnd(15)} (${result.symbol})`;
      output += `\n   Alerting balance: ${result.balance.toFixed(6)} ${result.symbol} ($${result.dollarValue.toFixed(2)})`;
      output += `\n   Target: $${result.targetDollarValue.toFixed(2)}`;
      output += `\n   Current: ${result.percentageOfTarget.toFixed(1)}% of target`;
      output += '\n';
    }
  }

  // Single console.log for all output
  console.log(output);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
