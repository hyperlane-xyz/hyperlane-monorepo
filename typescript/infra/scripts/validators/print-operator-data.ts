import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';

import { getRegistryWithOverrides } from '../../config/registry.js';

const registry = getRegistryWithOverrides();

function printSeparator() {
  console.log(
    '\n----------------------------------------------------------------------------\n',
  );
}

async function printValidatorsPerOperator() {
  const operatorMap: Record<
    string,
    {
      count: number;
      chains: string[];
      displayChains?: string;
    }
  > = {};

  for (const [chain, { validators }] of Object.entries(
    defaultMultisigConfigs,
  )) {
    const chainMetadata = await registry.getChainMetadata(chain);
    if (chainMetadata?.isTestnet) {
      continue;
    }

    for (const validator of validators) {
      operatorMap[validator.alias] = operatorMap[validator.alias] || {
        count: 0,
        chains: [],
      };
      operatorMap[validator.alias].count++;
      operatorMap[validator.alias].chains.push(chain);
    }
  }

  // Convert chains array to comma-separated string for each operator
  for (const operator of Object.keys(operatorMap)) {
    operatorMap[operator].displayChains =
      operatorMap[operator].chains.join(', ');
  }

  console.log('VALIDATORS PER OPERATOR:');
  for (const [operator, data] of Object.entries(operatorMap)) {
    console.log(`${operator} (${data.count}):\n- ${data.displayChains}\n`);
  }
}

async function printAbacusVsThirdParty() {
  let abacusCount = 0;
  let thirdPartyCount = 0;
  const abacusChains = new Set<string>();
  const thirdPartyChains = new Set<string>();

  for (const [chain, { threshold, validators }] of Object.entries(
    defaultMultisigConfigs,
  )) {
    const chainMetadata = await registry.getChainMetadata(chain);
    // Don't log testnets
    if (chainMetadata?.isTestnet) {
      continue;
    }

    // Skip non-production chains
    if (threshold === 1) {
      console.log(`Skipping ${chain} with threshold ${threshold}`);
      continue;
    }

    for (const validator of validators) {
      if (validator.alias.toLowerCase().includes('abacus')) {
        abacusCount++;
        abacusChains.add(chain);
      } else {
        thirdPartyCount++;
        thirdPartyChains.add(chain);
      }
    }
  }

  console.log('VALIDATOR DISTRIBUTION:');
  console.log(
    `Abacus Works: ${abacusCount} validators across ${abacusChains.size} chains`,
  );
  console.log(
    `Third Party: ${thirdPartyCount} validators across ${thirdPartyChains.size} chains`,
  );
  console.log(`Total: ${abacusCount + thirdPartyCount} validators`);
}

async function printChainDistribution() {
  const chainDistribution: Record<
    string,
    {
      chain: string;
      abacusCount: number;
      thirdPartyCount: number;
      total: number;
      abacusPercent: string;
      thirdPartyPercent: string;
    }
  > = {};

  for (const [chain, { threshold, validators }] of Object.entries(
    defaultMultisigConfigs,
  )) {
    const chainMetadata = await registry.getChainMetadata(chain);
    // Don't log testnets
    if (chainMetadata?.isTestnet) {
      continue;
    }

    // Skip non-production chains
    if (threshold === 1) {
      console.log(`Skipping ${chain} with threshold ${threshold}`);
      continue;
    }

    let abacus = 0;
    let thirdParty = 0;
    for (const validator of validators) {
      if (validator.alias.toLowerCase().includes('abacus')) {
        abacus++;
      } else {
        thirdParty++;
      }
    }

    const total = abacus + thirdParty;
    chainDistribution[chain] = {
      chain,
      abacusCount: abacus,
      thirdPartyCount: thirdParty,
      total,
      abacusPercent: ((abacus / total) * 100).toFixed(1) + '%',
      thirdPartyPercent: ((thirdParty / total) * 100).toFixed(1) + '%',
    };
  }

  // Log chains with fewer than 3 validators as not in production yet
  const lowValidatorChains = Object.values(chainDistribution)
    .filter((data) => data.total < 3)
    .map((data) => data.chain);

  console.log('CHAIN-LEVEL DISTRIBUTION:');
  console.table(
    Object.values(chainDistribution).map(
      ({
        chain,
        abacusCount,
        thirdPartyCount,
        total,
        abacusPercent,
        thirdPartyPercent,
      }) => ({
        chain,
        total,
        AW: abacusCount,
        external: thirdPartyCount,
        'AW %': abacusPercent,
        'external %': thirdPartyPercent,
      }),
    ),
  );

  if (lowValidatorChains.length > 0) {
    console.log(
      `\n${lowValidatorChains.length} chains not yet in production (< 3 validators):`,
    );
    console.log(lowValidatorChains.join(', '));
    console.log(''); // Empty line for spacing
  }
}

async function main() {
  printSeparator();
  await printValidatorsPerOperator();
  printSeparator();
  await printAbacusVsThirdParty();
  printSeparator();
  await printChainDistribution();
  printSeparator();
}

main().catch(console.error);
