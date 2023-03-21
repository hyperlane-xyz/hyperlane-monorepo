import path from 'path';

import {
  ChainMap,
  LiquidityLayerApp,
  LiquidityLayerContracts,
  buildContracts,
  liquidityLayerFactories,
} from '@hyperlane-xyz/sdk';
import { error, log } from '@hyperlane-xyz/utils';

import { bridgeAdapterConfigs } from '../../config/environments/testnet3/token-bridge';
import { readJSON, sleep } from '../../src/utils/utils';
import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from '../utils';

async function relayPortalTransfers() {
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
  const contracts = buildContracts(
    addresses,
    liquidityLayerFactories,
  ) as ChainMap<LiquidityLayerContracts>;
  const app = new LiquidityLayerApp(
    contracts,
    multiProvider,
    bridgeAdapterConfigs,
  );

  while (true) {
    for (const chain of Object.keys(bridgeAdapterConfigs)) {
      console.log('Processing chain', chain);

      const txHashes = await app.fetchPortalBridgeTransactions(chain);
      const portalMessages = (
        await Promise.all(
          txHashes.map((txHash) => app.parsePortalMessages(chain, txHash)),
        )
      ).flat();

      log('Portal messages', portalMessages);

      // Poll for attestation data and submit
      for (const message of portalMessages) {
        try {
          await app.attemptPortalTransferCompletion(message);
        } catch (err) {
          error('Error attempting portal transfer', {
            message,
            err,
          });
        }
      }
      await sleep(10000);
    }
  }
}

relayPortalTransfers().then(console.log).catch(console.error);
