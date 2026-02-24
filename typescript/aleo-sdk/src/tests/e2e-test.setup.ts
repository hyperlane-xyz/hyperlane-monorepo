import type { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { runAleoNode } from '../testing/index.js';

// Timeout for setup: image pull + container startup (120s) + buffer
const SETUP_TIMEOUT_MS = 150_000;

let aleoNodeContainer: StartedTestContainer | undefined;

before(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  rootLogger.info('Starting Aleo devnode...');
  aleoNodeContainer = await runAleoNode();
  rootLogger.info('Aleo devnode started successfully');
});

after(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  if (aleoNodeContainer) {
    rootLogger.info('Stopping Aleo devnode...');
    await aleoNodeContainer.stop();
    rootLogger.info('Aleo devnode stopped');
  }
});
