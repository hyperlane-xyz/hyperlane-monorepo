import { rootLogger } from '@hyperlane-xyz/utils';

import { getKesselRunMultiProvider } from '../../src/kesselrunner/config.js';

async function printOwnerNonces() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const noncesObject = await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        const provider = multiProvider.getProvider(chain);
        const address = multiProvider.getSignerAddress(chain);
        const nonce = await provider.getTransactionCount(address);
        return {
          chain,
          nonce,
          address,
        };
      } catch (error) {
        rootLogger.error(`Error fetching nonce for chain ${chain}:`, error);
        return {
          chain,
          nonce: 'ERROR',
          address: 'ERROR',
        };
      }
    }),
  );

  const formattedNonces = noncesObject.reduce((acc, { chain, nonce }) => {
    acc[chain] = { nonce };
    return acc;
  }, {} as Record<string, any>);

  // eslint-disable-next-line no-console
  console.table(formattedNonces);
}

printOwnerNonces().catch((error) => {
  rootLogger.error('Error printing owner nonces:', error);
  process.exit(1);
});
