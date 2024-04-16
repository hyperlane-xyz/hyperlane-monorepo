import { BigNumber } from 'ethers';

import { HyperlaneIgp } from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { deployEnvToSdkEnv } from '../../src/config/environment.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// Some arbitrary threshold for now
const RECLAIM_BALANCE_THRESHOLD = BigNumber.from(10).pow(17);

async function main() {
  const { environment } = await getArgs().argv;
  const environmentConfig = getEnvironmentConfig(environment);
  const multiProvider = await environmentConfig.getMultiProvider();
  const igp = HyperlaneIgp.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );

  const paymasters = igp.map(
    (_, contracts) => contracts.interchainGasPaymaster,
  );

  const balances = await promiseObjAll(
    multiProvider.mapKnownChains((chain) => {
      const provider = multiProvider.getProvider(chain);
      const paymasterAddress = paymasters[chain].address;
      return provider.getBalance(paymasterAddress);
    }),
  );

  console.log('Balances', balances);

  const reclaimTxHashes = await promiseObjAll(
    objMap(paymasters, async (chain, paymaster) => {
      const balance = balances[chain];
      // Only reclaim when greater than the reclaim threshold
      if (balance.lt(RECLAIM_BALANCE_THRESHOLD)) {
        return 'N/A';
      }
      const tx = await paymaster.claim();
      return multiProvider.tryGetExplorerTxUrl(chain, tx);
    }),
  );

  console.log('Reclaim Transactions', reclaimTxHashes);
}

main()
  .then(() => console.log('Reclaim of funds successful!'))
  .catch(console.error);
