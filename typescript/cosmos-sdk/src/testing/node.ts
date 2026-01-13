import { GenericContainer, Wait } from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

export async function runCosmosNode({ rpcPort, restPort }: TestChainMetadata) {
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

  return container;
}
