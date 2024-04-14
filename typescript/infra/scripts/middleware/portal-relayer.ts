import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  LiquidityLayerApp,
  attachContractsMap,
  liquidityLayerFactories,
} from '@hyperlane-xyz/sdk';
import { rootLogger, sleep } from '@hyperlane-xyz/utils';

import { bridgeAdapterConfigs } from '../../config/environments/testnet4/token-bridge.js';
import { readJSON } from '../../src/utils/utils.js';
import { getArgs, getEnvironmentDirectory } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const logger = rootLogger.child({ module: 'portal-relayer' });

async function relayPortalTransfers() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
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

  const tick = async () => {
    for (const chain of Object.keys(bridgeAdapterConfigs)) {
      logger.info('Processing chain', {
        chain,
      });

      const txHashes = await app.fetchPortalBridgeTransactions(chain);
      const portalMessages = (
        await Promise.all(
          txHashes.map((txHash) => app.parsePortalMessages(chain, txHash)),
        )
      ).flat();

      logger.info('Portal messages', {
        portalMessages,
      });

      // Poll for attestation data and submit
      for (const message of portalMessages) {
        try {
          await app.attemptPortalTransferCompletion(message);
        } catch (err) {
          logger.error('Error attempting portal transfer', {
            message,
            err,
          });
        }
      }
      await sleep(10000);
    }
  };

  while (true) {
    try {
      await tick();
    } catch (err) {
      logger.error('Error processing chains in tick', {
        err,
      });
    }
  }
}

relayPortalTransfers().then(console.log).catch(console.error);
