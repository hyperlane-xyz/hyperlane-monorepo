import type { StartedTestContainer } from 'testcontainers';

import { rootLogger } from '@hyperlane-xyz/utils';

import { runAleoNode } from '../testing/index.js';

let aleoNodeContainer: StartedTestContainer | undefined;

// Store the current value to reset it after running the tests
const warpPrefix = process.env['ALEO_WARP_SUFFIX'];

export default async function setup() {
  // Delete the current value from the env so that tests can
  // set their custom value if needed
  delete process.env['ALEO_WARP_SUFFIX'];

  rootLogger.info('Starting Aleo devnode...');
  aleoNodeContainer = await runAleoNode();
  rootLogger.info('Aleo devnode started successfully');

  return async () => {
    if (warpPrefix === undefined) {
      delete process.env['ALEO_WARP_SUFFIX'];
    } else {
      process.env['ALEO_WARP_SUFFIX'] = warpPrefix;
    }

    if (aleoNodeContainer) {
      rootLogger.info('Stopping Aleo devnode...');
      await aleoNodeContainer.stop();
      rootLogger.info('Aleo devnode stopped');
    }
  };
}
