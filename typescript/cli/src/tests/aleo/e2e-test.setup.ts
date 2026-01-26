import fs from 'fs';
import { type StartedTestContainer } from 'testcontainers';

import { runAleoNode } from '@hyperlane-xyz/aleo-sdk/testing';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

let aleoNode1Container: StartedTestContainer | undefined;
let aleoNode2Container: StartedTestContainer | undefined;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Clean up existing chain addresses
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

  // Run both Aleo nodes in parallel
  [aleoNode1Container, aleoNode2Container] = await Promise.all([
    runAleoNode(TEST_CHAIN_METADATA_BY_PROTOCOL.aleo.CHAIN_NAME_1),
    runAleoNode(TEST_CHAIN_METADATA_BY_PROTOCOL.aleo.CHAIN_NAME_2),
  ]);
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

after(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Stop both Aleo nodes
  await Promise.all(
    [aleoNode1Container?.stop(), aleoNode2Container?.stop()].filter(Boolean),
  );
});
