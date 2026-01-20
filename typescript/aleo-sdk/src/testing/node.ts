import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

import {
  ALEO_DEVNODE_IMAGE,
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_ENV,
} from './constants.js';

/**
 * Starts a local Aleo devnode using testcontainers
 *
 * @param chainMetadata - Optional test chain metadata configuration (defaults to TEST_ALEO_CHAIN_METADATA)
 * @returns The started container instance
 */
export async function runAleoNode(
  chainMetadata: TestChainMetadata = TEST_ALEO_CHAIN_METADATA,
): Promise<StartedTestContainer> {
  const container = await new GenericContainer(ALEO_DEVNODE_IMAGE)
    .withExposedPorts({
      container: 3030,
      host: chainMetadata.rpcPort,
    })
    .withEnvironment(TEST_ALEO_ENV)
    .withCommand(['leo', 'devnode', 'start', '--listener-addr', '0.0.0.0:3030'])
    .withWaitStrategy(Wait.forLogMessage(/connection is ready/))
    .start();

  return container;
}
