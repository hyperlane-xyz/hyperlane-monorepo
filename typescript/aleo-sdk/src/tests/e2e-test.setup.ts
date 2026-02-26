import type { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { runAleoNode } from '../testing/index.js';

// Timeout for setup: image pull + container startup (120s) + buffer
const SETUP_TIMEOUT_MS = 150_000;

let aleoNodeContainer: StartedTestContainer | undefined;

// Store the current value to reset it after running the tests
const warpPrefix = process.env['ALEO_WARP_SUFFIX'];

before(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

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
  if (warpPrefix === undefined) {
    delete process.env['ALEO_WARP_SUFFIX'];
  } else {
    process.env['ALEO_WARP_SUFFIX'] = warpPrefix;
  }

  this.timeout(SETUP_TIMEOUT_MS);

  if (aleoNodeContainer) {
    rootLogger.info('Stopping Aleo devnode...');
    await aleoNodeContainer.stop();
    rootLogger.info('Aleo devnode stopped');
  }
});
