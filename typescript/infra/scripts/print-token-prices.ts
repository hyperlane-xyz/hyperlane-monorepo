import { ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMap, pick } from '@hyperlane-xyz/utils';

// Intentionally circumvent `{mainnet3,testnet4}/index.ts` and `getEnvironmentConfig({'mainnet3','testnet4'})`
// to avoid circular dependencies.
import { getRegistry as getMainnet3Registry } from '../config/environments/mainnet3/chains.js';
import { supportedChainNames as mainnet3SupportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { getRegistry as getTestnet4Registry } from '../config/environments/testnet4/chains.js';
import { supportedChainNames as testnet4SupportedChainNames } from '../config/environments/testnet4/supportedChainNames.js';

import { getArgs } from './agent-utils.js';

const CURRENCY = 'usd';

async function main() {
  const { environment } = await getArgs().argv;

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

  const prices = objMap(ids, (_, id) => {
    const idData = idPrices[id];
    if (!idData) {
      throw new Error(
        `No data for ${id}, did you set gasCurrencyCoinGeckoId in the metadata?`,
      );
    }
    const price = idData[CURRENCY];
    if (!price) {
      throw new Error(`No ${CURRENCY} price for ${id}`);
    }
    return price.toString();
  });

  console.log(JSON.stringify(prices, null, 2));
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
