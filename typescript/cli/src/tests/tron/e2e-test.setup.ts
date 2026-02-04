import fs from 'fs';

import {
  CHAIN_NAME_1,
  CHAIN_NAME_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './consts.js';

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Clean up existing chain addresses
  for (const chainName of [CHAIN_NAME_1, CHAIN_NAME_2]) {
    const path = `${REGISTRY_PATH}/chains/${chainName}/addresses.yaml`;
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  }
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});
