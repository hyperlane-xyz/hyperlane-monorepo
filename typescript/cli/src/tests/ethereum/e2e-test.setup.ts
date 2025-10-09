import fs from 'fs';

import {
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runEvmNode } from '../nodes.js';

before(async function () {
  this.timeout(5000);

  await runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2);
  await runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3);
  await runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4);

  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
    ([_protocol, chainNames]) => {
      Object.entries(chainNames).map(([_key, name]) => {
        const path = `${REGISTRY_PATH}/chains/${name}/addresses.yaml`;

        if (fs.existsSync(path)) {
          fs.rmSync(path, { recursive: true, force: true });
        }
      });
    },
  );
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});
