import { StartedDockerComposeEnvironment } from 'testcontainers';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { deepCopy } from '@hyperlane-xyz/utils';

import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_CHAIN_METADATA,
} from '../testing/constants.js';
import { runRadixNode } from '../testing/node.js';
import {
  deployHyperlaneRadixPackage,
  downloadRadixContracts,
} from '../testing/setup.js';

let radixNodeInstance: StartedDockerComposeEnvironment;

// Global chain metadata with deployed package address
export let DEPLOYED_TEST_CHAIN_METADATA: TestChainMetadata;

before(async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  // Download Radix contracts
  const artifacts = await downloadRadixContracts();

  // Start node
  radixNodeInstance = await runRadixNode(TEST_RADIX_CHAIN_METADATA, artifacts);

  // Deploy Hyperlane package and get address
  const packageAddress = await deployHyperlaneRadixPackage(
    TEST_RADIX_CHAIN_METADATA,
    artifacts,
  );

  // Store metadata with package address for tests to use
  DEPLOYED_TEST_CHAIN_METADATA = deepCopy(TEST_RADIX_CHAIN_METADATA);
  DEPLOYED_TEST_CHAIN_METADATA.packageAddress = packageAddress;
});

after(async function () {
  // Might take a while shutting down the compose environment
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  if (radixNodeInstance) {
    await radixNodeInstance.down();
  }
});
