import { rootLogger } from '@hyperlane-xyz/utils';

import { KESSEL_RUN_FUNDER_CONFIG } from '../../src/kesselrunner/config.js';
import { getKesselRunMultiProvider } from '../../src/kesselrunner/utils.js';

async function printNonces() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const noncesObject = await Promise.all(
    targetNetworks.flatMap((chain) => {
      return Object.entries(KESSEL_RUN_FUNDER_CONFIG).map(
        async ([type, address]) => {
          try {
            const provider = multiProvider.getProvider(chain);
            const nonce = await provider.getTransactionCount(address);
            return {
              chain,
              type,
              nonce,
              address,
            };
          } catch (error) {
            rootLogger.error(
              `Error fetching nonce for ${type} on chain ${chain}:`,
              error,
            );
            return {
              chain,
              type,
              nonce: 'ERROR',
              address: 'ERROR',
            };
          }
        },
      );
    }),
  );

  const formattedNonces = noncesObject.reduce((acc, { chain, type, nonce }) => {
    if (!acc[chain]) acc[chain] = {};
    acc[chain][type] = nonce;
    return acc;
  }, {} as Record<string, any>);

  // eslint-disable-next-line no-console
  console.table(formattedNonces);
}

printNonces().catch((error) => {
  rootLogger.error('Error printing nonces:', error);
  process.exit(1);
});
