import { Argv } from 'yargs';

import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';
import { readFile } from 'fs/promises';

export function withOriginChain<T>(args: Argv<T>) {
  return args
    .describe('originChain', 'The chain for which IGP prices are calculated')
    .alias('o', 'origin-chain')
    .default('originChain', '')
    .demandOption('originChain');
}

export function withCommandPrefix<T>(args: Argv<T>) {
  return args
    .describe(
      'commandPrefix',
      'The command for the Cosmos CLI, it will be prepended to IGP config args.',
    )
    .example(
      'commandPrefix',
      'celestiad tx hyperlane hooks igp set-destination-gas-config [igp-id]',
    )
    .alias('p', 'command-prefix')
    .default('commandPrefix', '');
}

/**
 * Generates the command(s) for the CosmosSDK CLI to deploy ISMs.
 */

async function main() {
  const { environment, chains, commandPrefix, originChain } =
    await withOriginChain(withCommandPrefix(withChains(getArgs()))).argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  if (chains == undefined) {
    throw new Error('Chains must be provided');
  }

  const gasPrices = JSON.parse(
    await readFile('config/environments/mainnet3/gasPrices.json', 'utf-8'),
  );
  const tokenPrices = JSON.parse(
    await readFile('config/environments/mainnet3/tokenPrices.json', 'utf-8'),
  );

  const tokenPriceConfigs = chains.map((chain) => {
    if (!tokenPrices.hasOwnProperty(chain)) {
      throw Error(`No token price found for ${chain}`);
    }
    if (!gasPrices.hasOwnProperty(chain)) {
      throw Error(`No token price found for ${chain}`);
    }

    return {
      name: chain,
      domain_id: multiProvider.getDomainId(chain),
      token_price: tokenPrices[chain],
      gas_price_amount: gasPrices[chain].amount,
      gas_price_decimals: gasPrices[chain].amount,
    };
  });

  if (!tokenPrices.hasOwnProperty(originChain)) {
    throw Error(`No token price found for ${originChain}`);
  }

  for (const entry of tokenPriceConfigs) {
    const token_price = parseFloat(entry.token_price);
    const origin_token_price = parseFloat(tokenPrices[originChain]);

    let ratio = origin_token_price / token_price;

    // Split scaling factor equally between price and ratio
    ratio = Math.round(ratio * 10000);
    const gas_price = Math.round(parseFloat(entry.gas_price_amount) * 10000);

    console.log(`${entry.name}: ${entry.domain_id}`);
    console.log(
      `${commandPrefix} ${entry.domain_id} ${ratio} ${gas_price} 50000`,
    );
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
