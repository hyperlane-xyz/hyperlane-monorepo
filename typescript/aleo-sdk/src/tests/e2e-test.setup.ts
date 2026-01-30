import type { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_E2E_TEST_TIMEOUT, runAleoNode } from '../testing/index.js';

let aleoNodeContainer: StartedTestContainer | undefined;

// Store the current value to reset it after running the tests
const warpPrefix = process.env['ALEO_WARP_SUFFIX'];

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  rootLogger.info('Starting Aleo devnode...');
  aleoNodeContainer = await runAleoNode();
  rootLogger.info('Aleo devnode started successfully');
});

beforeEach(function () {
  // Delete the current value from the env so that tests can
  // set their custom value if needed
  delete process.env['ALEO_WARP_SUFFIX'];
});

after(async function () {
  process.env['ALEO_WARP_SUFFIX'] = warpPrefix;

  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  if (aleoNodeContainer) {
    rootLogger.info('Stopping Aleo devnode...');
    await aleoNodeContainer.stop();
    rootLogger.info('Aleo devnode stopped');
  }
});
