import path from 'path';

import {
  ChainMap,
  Chains,
  TokenBridgeApp,
  buildContracts,
  objMap,
  tokenBridgeFactories,
} from '@hyperlane-xyz/sdk';
import { TokenBridgeContracts } from '@hyperlane-xyz/sdk/dist/tokenBridge';

import { circleBridgeAdapterConfig } from '../config/environments/testnet2/token-bridge';
import { readJSON, sleep } from '../src/utils/utils';

import {
  getCoreEnvironmentConfig,
  getEnvironment,
  getEnvironmentDirectory,
} from './utils';

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const dir = path.join(
    getEnvironmentDirectory(environment),
    'middleware/token-bridge',
  );
  const addresses = readJSON(dir, 'addresses.json');
  // @ts-ignore
  const contracts: ChainMap<any, TokenBridgeContracts> = buildContracts(
    addresses,
    tokenBridgeFactories,
  );
  const app = new TokenBridgeApp(
    contracts,
    multiProvider,
    objMap(circleBridgeAdapterConfig, (_chain, conf) => [conf]),
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
      await Promise.all(
        circleDispatches.map((message) =>
          app.attemptCircleAttestationSubmission(message),
        ),
      );

      await sleep(6000);
    }
  }
}

check().then(console.log).catch(console.error);
