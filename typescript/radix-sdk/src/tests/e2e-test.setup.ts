import { StartedDockerComposeEnvironment } from 'testcontainers';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_CHAIN_METADATA,
} from '../testing/constants.js';
import { runRadixNode } from '../testing/node.js';
import { downloadRadixContracts } from '../testing/setup.js';

let radixNodeInstance: StartedDockerComposeEnvironment;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Download Radix contracts
  const artifacts = await downloadRadixContracts();

  // Start node and deploy Hyperlane package
  radixNodeInstance = await runRadixNode(TEST_RADIX_CHAIN_METADATA, artifacts);
});

after(async function () {
  // Might take a while shutting down the compose environment
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  if (radixNodeInstance) {
    await radixNodeInstance.down();
  }
});
