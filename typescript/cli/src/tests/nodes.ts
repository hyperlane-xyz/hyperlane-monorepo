import { GenericContainer, Wait } from 'testcontainers';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

export async function runEvmNode({ rpcPort, chainId }: TestChainMetadata) {
  const container = await new GenericContainer(
    'ghcr.io/foundry-rs/foundry:latest',
  )
    .withEntrypoint([
      'anvil',
      '--host',
      '0.0.0.0',
      '-p',
      rpcPort.toString(),
      '--chain-id',
      chainId.toString(),
    ])
    .withExposedPorts({
      container: rpcPort,
      host: rpcPort,
    })
    .withWaitStrategy(Wait.forLogMessage(/Listening on/))
    .start();

  return container;
}

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
    .start();

  return container;
}
