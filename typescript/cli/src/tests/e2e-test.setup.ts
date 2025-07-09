import fs from 'fs';

import { REGISTRY_PATH } from './commands/helpers.js';

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});
