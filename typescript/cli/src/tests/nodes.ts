import {
  DockerComposeEnvironment,
  GenericContainer,
  Wait,
} from 'testcontainers';

export async function runAnvilNode(port: number, chainId: number) {
  const container = await new GenericContainer(
    'ghcr.io/foundry-rs/foundry:latest',
  )
    .withEntrypoint([
      'anvil',
      '--host',
      '0.0.0.0',
      '-p',
      port.toString(),
      '--chain-id',
      chainId.toString(),
    ])
    .withExposedPorts({
      container: port,
      host: port,
    })
    .withWaitStrategy(Wait.forLogMessage(/Listening on/))
    .start();

  return container;
}

export async function runCosmosNode() {
  const environment = await new DockerComposeEnvironment(
    // TODO: parametrize this based on the current host
    '/Users/xeno097/Desktop/hyperlane/hyperlane-monorepo/typescript/cli',
    'compose.yaml',
  ).up();

  return environment;
}
