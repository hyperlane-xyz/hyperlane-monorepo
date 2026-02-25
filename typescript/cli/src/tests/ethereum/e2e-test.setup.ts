import fs from 'fs';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';
import { runEvmNode, runTronNode } from '../nodes.js';

import { IS_TRON_TEST, REGISTRY_PATH as OLD_REGISTRY_PATH } from './consts.js';

const SKIP_EVM_TESTCONTAINERS = process.env.SKIP_EVM_TESTCONTAINERS === '1';

before(async function () {
  // Use longer timeout for Tron (node startup is slower)
  this.timeout(
    IS_TRON_TEST ? 3 * DEFAULT_E2E_TEST_TIMEOUT : DEFAULT_E2E_TEST_TIMEOUT,
  );

  if (IS_TRON_TEST) {
    // Single Tron node handles all 3 logical chains (anvil2/3/4 aliases).
    // runTronNode uses a fixed mnemonic so ANVIL_KEY matches account 0.
    await runTronNode({
      name: 'tron-local',
      chainId: 3360022319,
      domainId: 3360022319,
      port: 9090,
    });
  } else {
    // Separate Anvil nodes for each chain
    if (!SKIP_EVM_TESTCONTAINERS) {
      await Promise.all([
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3),
        runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_4),
      ]);
    }
  }

  // Clean up existing chain addresses
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
