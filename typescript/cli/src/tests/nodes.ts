import { DockerComposeEnvironment, GenericContainer } from 'testcontainers';

export async function runAnvilNode(exposedPort: number) {
  const container = await new GenericContainer('foundry:latest')
    .withEnvironment({
      ANVIL_IP_ADDR: '0.0.0.0',
    })
    .withExposedPorts(exposedPort)
    .start();

  return container;
}

export async function runCosmosNode() {
  const environment = await new DockerComposeEnvironment(
    '/Users/xeno097/Desktop/hyperlane/hyperlane-monorepo/typescript/cli',
    'compose.yaml',
  ).up();

  return environment;
}
