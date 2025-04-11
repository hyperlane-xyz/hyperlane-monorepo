import { formatUnits } from 'ethers/lib/utils.js';

import { rootLogger } from '@hyperlane-xyz/utils';

import { getKesselRunMultiProvider } from '../../src/kesselrunner/config.js';

async function printOwnerBalances() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const balancesObject = await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        const provider = multiProvider.getProvider(chain);
        const { decimals, symbol } = await multiProvider.getNativeToken(chain);
        const address = multiProvider.getSignerAddress(chain);
        const balance = await provider.getBalance(address);
        const formattedBalance = formatUnits(balance, decimals);
        return {
          chain,
          balance: Number(formattedBalance).toFixed(3),
          symbol,
          address,
        };
      } catch (error) {
        rootLogger.error(`Error fetching balance for chain ${chain}:`, error);
        return {
          chain,
          balance: 'ERROR',
          symbol: 'ERROR',
          address: 'ERROR',
        };
      }
    }),
  );

  const formattedBalances = balancesObject.reduce(
    (acc, { chain, balance, symbol }) => {
      acc[chain] = { balance, symbol };
      return acc;
    },
    {} as Record<string, any>,
  );

  // eslint-disable-next-line no-console
  console.table(formattedBalances);
}

printOwnerBalances().catch((error) => {
  rootLogger.error('Error printing owner balances:', error);
  process.exit(1);
});
