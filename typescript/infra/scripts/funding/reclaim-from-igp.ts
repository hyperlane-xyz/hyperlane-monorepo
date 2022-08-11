import { AbacusCore, objMap, promiseObjAll } from '@abacus-network/sdk';

import { getEnvironment, getEnvironmentConfig } from '../utils';

async function main() {
  const environment = await getEnvironment();
  const coreConfig = await getEnvironmentConfig();
  const multiProvider = await coreConfig.getMultiProvider();
  const core: AbacusCore<any> = AbacusCore.fromEnvironment(
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
