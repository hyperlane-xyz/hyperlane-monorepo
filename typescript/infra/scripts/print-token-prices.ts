import chalk from 'chalk';

import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMap, pick } from '@hyperlane-xyz/utils';

// Intentionally circumvent `{mainnet3,testnet4}/index.ts` and `getEnvironmentConfig({'mainnet3','testnet4'})`
// to avoid circular dependencies.
import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import mainnet3TokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';
import testnet4TokenPrices from '../config/environments/testnet4/tokenPrices.json' with { type: 'json' };
import { DeployEnvironment } from '../src/config/environment.js';
import { writeJsonAtPath } from '../src/utils/utils.js';

import { getArgs, withWrite } from './agent-utils.js';

const CURRENCY = 'usd';

const DEFAULT_PRICE = {
  mainnet3: '1',
  testnet4: '10',
  test: '100',
};

const tokenPricesFilePath = (environment: DeployEnvironment) => {
  return `config/environments/${environment}/tokenPrices.json`;
};

// 5% threshold, adjust as needed
const DIFF_THRESHOLD_PCT = 5;

async function main() {
  const { environment, write } = await withWrite(getArgs()).argv;

  const { registry, supportedChainNames } =
    environment === 'mainnet3'
      ? {
          registry: await getMainnet3Registry(),
          supportedChainNames: mainnet3SupportedChainNames,
        }
      : {
          registry: await getTestnet4Registry(),
          supportedChainNames: testnet4SupportedChainNames,
        };

  const chainMetadata = await registry.getMetadata();
  const metadata = pick(
    chainMetadata as Record<
      (typeof supportedChainNames)[number],
      ChainMetadata
    >,
    [...supportedChainNames],
  );

  const ids = objMap(
    metadata,
    (_, metadata) => metadata.gasCurrencyCoinGeckoId ?? metadata.name,
  );

  const resp = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${Object.entries(
      ids,
    ).join(',')}&vs_currencies=${CURRENCY}`,
  );

  const idPrices = await resp.json();

  // Only update if the new price diff is greater than DIFF_THRESHOLD_PCT, otherwise keep the old price.
  // Defensive: handle missing or malformed current price
  const prevTokenPrices: ChainMap<string> =
    environment === 'mainnet3' ? mainnet3TokenPrices : testnet4TokenPrices;

  const prices = objMap(ids, (chain, id) => {
    const idData = idPrices[id];
    const prevPriceRaw = prevTokenPrices[chain];
    const prevPrice =
      prevPriceRaw && !isNaN(Number(prevPriceRaw))
        ? Number(prevPriceRaw)
        : Number(DEFAULT_PRICE[environment]);

    let newPrice: number | undefined;
    if (!idData) {
      console.warn(
        chalk.yellow(
          `No data for ${id}, using ${DEFAULT_PRICE[environment]} as a default`,
        ),
      );
      newPrice = Number(DEFAULT_PRICE[environment]);
    } else {
      const price = idData[CURRENCY];
      if (!price) {
        console.warn(
          chalk.yellow(
            `No ${CURRENCY} price for ${id}, using ${DEFAULT_PRICE[environment]} as a default`,
          ),
        );
        newPrice = Number(DEFAULT_PRICE[environment]);
      } else {
        newPrice = Number(price);
      }
    }

    // If previous is zero, always update (avoid division by zero)
    let shouldUpdate = false;
    if (prevPrice === 0) {
      shouldUpdate = true;
    } else {
      const diff = Math.abs(newPrice - prevPrice) / prevPrice;
      shouldUpdate = diff > DIFF_THRESHOLD_PCT / 100;
    }

    return shouldUpdate ? newPrice.toString() : prevPrice.toString();
  });

  if (write) {
    const outFile = tokenPricesFilePath(environment);
    console.log(`Writing token prices to ${outFile}`);
    writeJsonAtPath(outFile, prices);
  } else {
    console.log(JSON.stringify(prices, null, 2));
  }

  process.exit(0);
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
