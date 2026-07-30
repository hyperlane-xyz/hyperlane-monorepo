import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { retryAsync, sleep } from '@hyperlane-xyz/utils';

import {
  ALEO_DEVNODE_IMAGE,
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_ENV,
} from './constants.js';

// Timeout for container startup (includes image pull + container start + wait strategy)
const CONTAINER_STARTUP_TIMEOUT_MS = 120_000;

/**
 * Starts a local Aleo devnode using testcontainers
 *
 * @param chainMetadata - Optional test chain metadata configuration (defaults to TEST_ALEO_CHAIN_METADATA)
 * @returns The started container instance
 */
export async function runAleoNode(
  chainMetadata: TestChainMetadata = TEST_ALEO_CHAIN_METADATA,
): Promise<StartedTestContainer> {
  // Retry container start to handle transient Docker registry 503 errors in CI
  const container = await retryAsync(
    () =>
      new GenericContainer(ALEO_DEVNODE_IMAGE)
        // The image is only published for linux/amd64 (no official Linux
        // arm64 leo binary exists). Requesting the platform explicitly lets
        // Docker run it under emulation on arm64 hosts instead of failing
        // to find a matching manifest.
        .withPlatform('linux/amd64')
        .withExposedPorts({
          container: 3030,
          host: chainMetadata.rpcPort,
        })
        .withEnvironment(TEST_ALEO_ENV)
        .withCommand([
          'leo',
          'devnode',
          'start',
          '--socket-addr',
          '0.0.0.0:3030',
        ])
        .withWaitStrategy(Wait.forLogMessage(/connection is ready/))
        .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
        .start(),
    3,
    5000,
  );

  // Wait to give enough time to the node to start
  await sleep(5000);

  return container;
}
