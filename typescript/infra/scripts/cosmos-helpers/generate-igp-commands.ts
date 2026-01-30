import { Argv } from 'yargs';

import rawGasPrices from '../../config/environments/mainnet3/gasPrices.json' with { type: 'json' };
import rawTokenPrices from '../../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

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

  const gasPrices = rawGasPrices as unknown as {
    [key: string]: { amount: string; decimals: number };
  };
  const tokenPrices = rawTokenPrices as unknown as { [key: string]: string };

  const registry = await config.getRegistry(false);

  const tokenPriceConfigs = chains.map((chain) => {
    if (!tokenPrices[chain]) {
      throw Error(`No token price found for ${chain}`);
    }
    if (!gasPrices[chain]) {
      throw Error(`No gas price found for ${chain}`);
    }

    return {
      name: chain,
      domain_id: multiProvider.getDomainId(chain),
      token_price: tokenPrices[chain],
      gas_price_amount: gasPrices[chain].amount,
      gas_price_decimals: gasPrices[chain].decimals,
    };
  });

  if (!tokenPrices[originChain]) {
    throw Error(`No token price found for ${originChain}`);
  }

  for (const entry of tokenPriceConfigs) {
    const token_price = parseFloat(entry.token_price);
    const origin_token_price = parseFloat(tokenPrices[originChain]);

    const destNativeTokenDecimals =
      (await registry.getChainMetadata(entry.name))?.nativeToken?.decimals ??
      18;
    const originNativeTokenDecimals =
      (await registry.getChainMetadata(originChain))?.nativeToken?.decimals ??
      18;

    let ratio = token_price / origin_token_price;

    let gasPriceSmallestUnit =
      parseFloat(entry.gas_price_amount) *
      Math.pow(10, entry.gas_price_decimals);
    let originDestDecimalsRatio = Math.pow(
      10,
      originNativeTokenDecimals - destNativeTokenDecimals,
    );

    let gasPrice = gasPriceSmallestUnit * originDestDecimalsRatio;

    // Split scaling factor equally between price and ratio
    ratio = Math.round(ratio);
    const gas_price = Math.round(gasPrice * 1e10);

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
