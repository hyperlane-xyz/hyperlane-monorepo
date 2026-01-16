import { GenericContainer, Wait } from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';

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
