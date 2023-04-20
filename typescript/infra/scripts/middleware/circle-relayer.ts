import path from 'path';

import {
  Chains,
  LiquidityLayerApp,
  attachContractsMap,
  liquidityLayerFactories,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../../config/environments/testnet3/token-bridge';
import { readJSON, sleep } from '../../src/utils/utils';
import {
  getEnvironment,
  getEnvironmentConfig,
  getEnvironmentDirectory,
} from '../utils';

async function check() {
  const environment = await getEnvironment();
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const dir = path.join(
    __dirname,
    '../../',
    getEnvironmentDirectory(environment),
    'middleware/liquidity-layer',
  );
  const addresses = readJSON(dir, 'addresses.json');
  const contracts = attachContractsMap(addresses, liquidityLayerFactories);
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
