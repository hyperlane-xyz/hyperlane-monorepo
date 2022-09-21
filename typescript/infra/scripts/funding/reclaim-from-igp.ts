import { BigNumber } from 'ethers';

import { HyperlaneCore, objMap, promiseObjAll } from '@hyperlane-xyz/sdk';

import { getEnvironment, getEnvironmentConfig } from '../utils';

// Some arbitrary treshold for now
const RECLAIM_BALANCE_THRESHOLD = BigNumber.from(10).pow(17);

async function main() {
  const environment = await getEnvironment();
  const coreConfig = await getEnvironmentConfig();
  const multiProvider = await coreConfig.getMultiProvider();
  const core: HyperlaneCore<any> = HyperlaneCore.fromEnvironment(
    environment,
    multiProvider,
  );

  const paymasters = core.map(
    (_, contracts) => contracts.interchainGasPaymaster,
  );

  const balances = await promiseObjAll(
    multiProvider.map((chain, chainConnection) => {
      const provider = chainConnection.provider;
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
      const tx = await paymaster.contract.claim();
      const chainConnection = multiProvider.getChainConnection(chain);
      return chainConnection.getTxUrl(tx);
    }),
  );

  console.log('Reclaim Transactions', reclaimTxHashes);
}

main()
  .then(() => console.log('Reclaim of funds successful!'))
  .catch(console.error);
