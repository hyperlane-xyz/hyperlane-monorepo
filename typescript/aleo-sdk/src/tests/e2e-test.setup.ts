import type { StartedTestContainer } from 'testcontainers';

import { DEFAULT_E2E_TEST_TIMEOUT, runAleoNode } from '../testing/index.js';

let aleoNodeContainer: StartedTestContainer | undefined;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  console.log('Starting Aleo devnode...');
  aleoNodeContainer = await runAleoNode();
  console.log('Aleo devnode started successfully');
});

after(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  if (aleoNodeContainer) {
    console.log('Stopping Aleo devnode...');
    await aleoNodeContainer.stop();
    console.log('Aleo devnode stopped');
  }
});
