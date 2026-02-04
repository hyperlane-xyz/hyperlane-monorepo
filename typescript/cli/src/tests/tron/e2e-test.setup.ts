import fs from 'fs';
import { type StartedDockerComposeEnvironment } from 'testcontainers';

import {
  type TronTestChainMetadata,
  runTronNode,
} from '@hyperlane-xyz/tron-sdk/testing';
import { rootLogger } from '@hyperlane-xyz/utils';

import {
  CHAIN_NAME_1,
  CHAIN_NAME_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './consts.js';

// Test chain metadata for tron1 (single node handles both chains)
const TRON_TEST_METADATA: TronTestChainMetadata = {
  name: CHAIN_NAME_1,
  chainId: 728126428,
  domainId: 728126428,
  rpcPort: 8545,
  httpPort: 8090,
};

let tronEnvironment: StartedDockerComposeEnvironment | undefined;

before(async function () {
  // Use 3x timeout for setup since Docker container startup can be slow
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  rootLogger.info('Starting Tron E2E test setup...');

  // Clean up existing chain addresses
  for (const chainName of [CHAIN_NAME_1, CHAIN_NAME_2]) {
    const path = `${REGISTRY_PATH}/chains/${chainName}/addresses.yaml`;
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  }

  // Start the Tron node
  tronEnvironment = await runTronNode(TRON_TEST_METADATA);

  rootLogger.info('Tron node started successfully');
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

after(async function () {
  this.timeout(60_000);

  if (tronEnvironment) {
    rootLogger.info('Stopping Tron node...');
    await tronEnvironment.down();
    rootLogger.info('Tron node stopped');
  }
});
