import { StartedDockerComposeEnvironment } from 'testcontainers';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, deepCopy } from '@hyperlane-xyz/utils';

import { TEST_RADIX_CHAIN_METADATA } from '../testing/constants.js';
import { runRadixNode } from '../testing/node.js';
import {
  deployHyperlaneRadixPackage,
  downloadRadixContracts,
} from '../testing/setup.js';

const PACKAGE_ADDRESS_ENV = 'RADIX_E2E_PACKAGE_ADDRESS';
const XRD_ADDRESS_ENV = 'RADIX_E2E_XRD_ADDRESS';

/**
 * Reads the deployed package address and XRD resource address from env vars
 * (set by the vitest globalSetup below) and returns a test chain metadata
 * object that tests can use to connect to the running Radix node.
 */
export function getDeployedTestChainMetadata(): TestChainMetadata {
  const packageAddress = process.env[PACKAGE_ADDRESS_ENV];
  const xrdAddress = process.env[XRD_ADDRESS_ENV];
  assert(
    packageAddress,
    `Expected ${PACKAGE_ADDRESS_ENV} env var to be set by e2e globalSetup`,
  );
  assert(
    xrdAddress,
    `Expected ${XRD_ADDRESS_ENV} env var to be set by e2e globalSetup`,
  );

  const metadata = deepCopy(TEST_RADIX_CHAIN_METADATA) as TestChainMetadata;
  metadata.packageAddress = packageAddress;
  if (metadata.nativeToken) {
    metadata.nativeToken.denom = xrdAddress;
  }
  return metadata;
}

let radixNodeInstance: StartedDockerComposeEnvironment | undefined;

export default async function setup() {
  // Download Radix contracts
  const artifacts = await downloadRadixContracts();

  // Start node
  radixNodeInstance = await runRadixNode(TEST_RADIX_CHAIN_METADATA, artifacts);

  // Deploy Hyperlane package and get address and XRD resource address
  const { packageAddress, xrdAddress } = await deployHyperlaneRadixPackage(
    TEST_RADIX_CHAIN_METADATA,
    artifacts,
  );

  // Expose deployed addresses to test workers via env vars (globalSetup runs
  // in a separate process from test files, so module-level exports don't work).
  process.env[PACKAGE_ADDRESS_ENV] = packageAddress;
  process.env[XRD_ADDRESS_ENV] = xrdAddress;

  return async () => {
    if (radixNodeInstance) {
      await radixNodeInstance.down();
    }
  };
}
