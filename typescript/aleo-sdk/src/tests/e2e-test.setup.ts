import type { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_E2E_TEST_TIMEOUT, runAleoNode } from '../testing/index.js';

let aleoNodeContainer: StartedTestContainer | undefined;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  rootLogger.info('Starting Aleo devnode...');
  aleoNodeContainer = await runAleoNode();
  rootLogger.info('Aleo devnode started successfully');
});

after(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  if (aleoNodeContainer) {
    rootLogger.info('Stopping Aleo devnode...');
    await aleoNodeContainer.stop();
    rootLogger.info('Aleo devnode stopped');
  }
});
