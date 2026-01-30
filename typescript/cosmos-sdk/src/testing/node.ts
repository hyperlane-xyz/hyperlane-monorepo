import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { sleep } from '@hyperlane-xyz/utils';

export async function runCosmosNode({
  rpcPort,
  restPort,
}: TestChainMetadata): Promise<StartedTestContainer> {
  const container = await new GenericContainer(
    'gcr.io/abacus-labs-dev/hyperlane-cosmos-simapp:v1.0.1',
  )
    .withExposedPorts(
      {
        // default port on the container
        container: 26657,
        host: rpcPort,
      },
      {
        // default port on the container
        container: 1317,
        host: restPort,
      },
    )
    .withWaitStrategy(Wait.forLogMessage(/received complete proposal block/))
    .start();

  // Wait for the block to be committed and RPC to be fully ready.
  // The log message only indicates a proposal was received, not that
  // the block was committed and sync info is available.
  await sleep(2000);

  return container;
}
