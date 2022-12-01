import path from 'path';

import {
  ChainMap,
  Chains,
  LiquidityLayerApp,
  buildContracts,
  liquidityLayerFactories,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../../config/environments/testnet3/liquidityLayer';
import { readJSON, sleep } from '../../src/utils/utils';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const dir = path.join(
    __dirname,
    '../../',
    getEnvironmentDirectory(environment),
    'middleware/liquidity-layer',
  );
  const addresses = readJSON(dir, 'addresses.json');
  // @ts-ignore
  const contracts: ChainMap<any, LiquidityLayerContracts> = buildContracts(
    addresses,
    liquidityLayerFactories,
  );
  const app = new LiquidityLayerApp(
    contracts,
    multiProvider,
    bridgeAdapterConfigs,
  );

  while (true) {
    for (const chain of [Chains.goerli, Chains.fuji]) {
      const txHashes = await app.fetchCircleMessageTransactions(chain);

      const circleDispatches = (
        await Promise.all(
          txHashes.map((txHash) => app.parseCircleMessages(chain, txHash)),
        )
      ).flat();

      // Poll for attestation data and submit
      for (const message of circleDispatches) {
        await app.attemptCircleAttestationSubmission(message);
      }

      await sleep(6000);
    }
  }
}

check().then(console.log).catch(console.error);
