import { objMap } from '@hyperlane-xyz/utils';

import { getEnvironmentConfig } from './core-utils';

const CURRENCY = 'usd';

async function main() {
  const environmentConfig = getEnvironmentConfig('mainnet3');

  const ids = objMap(
    environmentConfig.chainMetadataConfigs,
    (_, metadata) => metadata.gasCurrencyCoinGeckoId ?? metadata.name,
  );

  const resp = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${Object.entries(
      ids,
    ).join(',')}&vs_currencies=${CURRENCY}`,
  );

  const idPrices = await resp.json();

  const prices = objMap(ids, (_, id) => idPrices[id][CURRENCY].toString());

  console.log(JSON.stringify(prices, null, 2));
}

main()
  .then()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
