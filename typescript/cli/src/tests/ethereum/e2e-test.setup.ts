import fs from 'fs';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runEvmNode } from '../nodes.js';

import { REGISTRY_PATH as OLD_REGISTRY_PATH } from './consts.js';

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  await Promise.all([
    runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
    runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3),
    runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4),
  ]);

  for (const registryPath of [REGISTRY_PATH, OLD_REGISTRY_PATH]) {
    Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
      ([_protocol, chainNames]) => {
        Object.entries(chainNames).map(([_key, name]) => {
          const path = `${registryPath}/chains/${name}/addresses.yaml`;

          if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
          }
        });
      },
    );
  }
});

// Reset the test registry for each test invocation
beforeEach(() => {
  for (const registryPath of [REGISTRY_PATH, OLD_REGISTRY_PATH]) {
    const deploymentPaths = `${registryPath}/deployments/warp_routes`;

    if (fs.existsSync(deploymentPaths)) {
      fs.rmSync(deploymentPaths, { recursive: true, force: true });
    }
  }
});
