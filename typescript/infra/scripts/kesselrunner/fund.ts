import { confirm } from '@inquirer/prompts';
import { formatUnits, parseUnits } from 'ethers/lib/utils.js';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  getKesselRunMultiProvider,
  ltOwner,
  relayerAddress,
  setDeployerKey,
} from '../../src/kesselrunner/config.js';

async function printOwnerAndRelayerBalances() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const userConfirmation = await confirm({
    message: 'Do you want to top up the balances?',
    default: false,
  });

  if (!userConfirmation) {
    rootLogger.info('Top up operation cancelled.');
    process.exit(0);
  }

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

          // Determine top up amount based on chain and entity type
          const topUpAmount =
            ['bsctestnet', 'arbitrumsepolia'].includes(chain) &&
            entityType === 'owner'
              ? 10
              : 1;

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

        await topUpEntity(relayerAddress, 'relayer');
        await topUpEntity(ltOwner, 'owner');
      } catch (error) {
        rootLogger.error(`Error topping up on chain ${chain}:`, error);
      }
    }),
  );
}

printOwnerAndRelayerBalances().catch((error) => {
  rootLogger.error('Error printing owner and relayer balances:', error);
  process.exit(1);
});
