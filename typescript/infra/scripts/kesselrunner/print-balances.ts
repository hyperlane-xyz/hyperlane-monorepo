import { formatUnits } from 'ethers/lib/utils.js';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  funderConfig,
  getKesselRunMultiProvider,
} from '../../src/kesselrunner/config.js';

async function printBalances() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const balancesObject = await Promise.all(
    targetNetworks.flatMap((chain) => {
      return Object.entries(funderConfig).map(async ([type, address]) => {
        try {
          const provider = multiProvider.getProvider(chain);
          const { decimals, symbol } = await multiProvider.getNativeToken(
            chain,
          );
          const balance = await provider.getBalance(address);
          const formattedBalance = formatUnits(balance, decimals);
          return {
            chain,
            type,
            balance: Number(formattedBalance).toFixed(3),
            symbol,
            address,
          };
        } catch (error) {
          rootLogger.error(
            `Error fetching balance for ${type} on chain ${chain}:`,
            error,
          );
          return {
            chain,
            type,
            balance: 'ERROR',
            symbol: 'ERROR',
            address: 'ERROR',
          };
        }
      });
    }),
  );

  const formattedBalances = balancesObject.reduce(
    (acc, { chain, type, balance, symbol }) => {
      if (!acc[chain]) acc[chain] = {};
      acc[chain][type] = `${balance} ${symbol}`;
      return acc;
    },
    {} as Record<string, any>,
  );

  // eslint-disable-next-line no-console
  console.table(formattedBalances);
}

printBalances().catch((error) => {
  rootLogger.error('Error printing balances:', error);
  process.exit(1);
});
