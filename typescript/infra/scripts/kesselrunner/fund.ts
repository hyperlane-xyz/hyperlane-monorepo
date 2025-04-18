import { formatUnits, parseUnits } from 'ethers/lib/utils.js';

import { rootLogger } from '@hyperlane-xyz/utils';

import { KESSEL_RUN_FUNDER_CONFIG } from '../../src/kesselrunner/config.js';
import {
  getKesselRunMultiProvider,
  setDeployerKey,
} from '../../src/kesselrunner/utils.js';

async function fundAgents() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  await setDeployerKey(multiProvider);

  await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        const provider = multiProvider.getProvider(chain);
        const { decimals } = await multiProvider.getNativeToken(chain);

        const topUpEntity = async (
          entityAddress: string,
          entityType: string,
        ) => {
          const entityBalance = await provider.getBalance(entityAddress);
          const formattedEntityBalance = Number(
            formatUnits(entityBalance, decimals),
          );

          // default to 1 token
          let topUpAmount = 1;
          // vanguard entities get 2 tokens
          if (entityType.startsWith('vanguard')) {
            // need more for sepolia
            topUpAmount = chain === 'sepolia' ? 10 : 2;
          }
          // owner gets 10 tokens
          else if (entityType === 'owner') {
            topUpAmount = 10;
          }

          if (formattedEntityBalance < topUpAmount) {
            const topUpValue = parseUnits(
              (topUpAmount - formattedEntityBalance).toFixed(3),
              decimals,
            );
            if (topUpValue.lt(parseUnits('0.01', decimals))) {
              rootLogger.info(
                `Skipping top up for ${entityType} on ${chain} as the top up value is less than 0.01 tokens`,
              );
              return;
            }

            const funderAddress = await multiProvider.getSignerAddress(chain);
            const funderBalance = await provider.getBalance(funderAddress);

            if (funderBalance.lt(topUpValue)) {
              throw new Error(
                `Insufficient balance in funder account on chain ${chain}`,
              );
            }

            await multiProvider.sendTransaction(chain, {
              to: entityAddress,
              value: topUpValue,
            });

            rootLogger.info(
              `Topped up ${entityType} on ${chain} with ${
                topUpAmount - formattedEntityBalance
              } tokens`,
            );
          }
        };

        for (const [entityType, entityAddress] of Object.entries(
          KESSEL_RUN_FUNDER_CONFIG,
        )) {
          await topUpEntity(entityAddress, entityType);
        }
      } catch (error) {
        rootLogger.error(`Error topping up on chain ${chain}:`, error);
      }
    }),
  );
}

fundAgents().catch((error) => {
  rootLogger.error('Error funding agents:', error);
  process.exit(1);
});
