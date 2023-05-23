import path from 'path';

import {
  LiquidityLayerApp,
  attachContractsMap,
  liquidityLayerFactories,
  objFilter,
} from '@hyperlane-xyz/sdk';
import { LiquidityLayerConfig } from '@hyperlane-xyz/sdk/dist/middleware/liquidity-layer/LiquidityLayerRouterDeployer';

import { readJSON, sleep } from '../../src/utils/utils';
import {
  getEnvironment,
  getEnvironmentConfig,
  getEnvironmentDirectory,
} from '../utils';

async function check() {
  const environment = await getEnvironment();
  const config = getEnvironmentConfig(environment);

  if (config.liquidityLayerConfig === undefined) {
    throw new Error(`No liquidity layer config found for ${environment}`);
  }

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
    config.liquidityLayerConfig.bridgeAdapters,
  );

  while (true) {
    for (const chain of Object.keys(
      objFilter(
        config.liquidityLayerConfig.bridgeAdapters,
        (_, config): config is LiquidityLayerConfig => !!config.circle,
      ),
    )) {
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
