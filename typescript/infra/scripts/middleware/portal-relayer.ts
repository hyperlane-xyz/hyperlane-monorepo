import path from 'path';

import {
  ChainMap,
  LiquidityLayerApp,
  buildContracts,
  liquidityLayerFactories,
} from '@hyperlane-xyz/sdk';

import { bridgeAdapterConfigs } from '../../config/environments/testnet2/liquidityLayer';
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
    for (const chain of Object.keys(bridgeAdapterConfigs)) {
      const txHashes = await app.fetchPortalBridgeTransactions(chain);
      const portalMessages = (
        await Promise.all(
          txHashes.map((txHash) => app.parsePortalMessages(chain, txHash)),
        )
      ).flat();

      // Poll for attestation data and submit
      for (const message of portalMessages) {
        await app.attemptPortalTransferCompletion(message);
      }
      await sleep(10000);
    }
  }
}

check().then(console.log).catch(console.error);
