import { formatUnits } from 'ethers/lib/utils.js';

import { IERC20__factory } from '@hyperlane-xyz/core';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  KESSEL_RUN_FUNDER_CONFIG,
  KESSEL_RUN_SPICE_ROUTE,
  MILLENNIUM_FALCON_ADDRESS,
} from '../../src/kesselrunner/config.js';
import { getKesselRunMultiProvider } from '../../src/kesselrunner/utils.js';

async function printBalances() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const spiceBalancesObject = await Promise.all(
    Object.entries(KESSEL_RUN_SPICE_ROUTE).map(
      async ([chainName, addressOrDenom]) => {
        try {
          const signer = multiProvider.getSigner(chainName);
          const spiceToken = IERC20__factory.connect(addressOrDenom!, signer);
          const falconAddress = MILLENNIUM_FALCON_ADDRESS[chainName];
          const balance = await spiceToken.balanceOf(falconAddress);
          const formattedBalance = formatUnits(balance, 18);
          return {
            chain: chainName,
            type: 'falcon',
            balance: Number(formattedBalance).toFixed(3),
            symbol: 'SPICE',
            address: falconAddress,
          };
        } catch (error) {
          rootLogger.error(
            `Error fetching spice balance for falcon on chain ${chainName}:`,
            error,
          );
          return {
            chain: chainName,
            type: 'falcon',
            balance: 'ERROR',
            symbol: 'ERROR',
            address: 'ERROR',
          };
        }
      },
    ),
  );

  const formattedSpiceBalances = spiceBalancesObject.reduce(
    (acc, { chain, type, balance, symbol }) => {
      if (!acc[chain]) acc[chain] = {};
      acc[chain][type] = `${balance} ${symbol}`;
      return acc;
    },
    {} as Record<string, any>,
  );

  // eslint-disable-next-line no-console
  console.table(formattedSpiceBalances);

  const balancesObject = await Promise.all(
    targetNetworks.flatMap((chain) => {
      return Object.entries(KESSEL_RUN_FUNDER_CONFIG).map(
        async ([type, address]) => {
          try {
            const provider = multiProvider.getProvider(chain);
            const { decimals, symbol } =
              await multiProvider.getNativeToken(chain);
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
        },
      );
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
