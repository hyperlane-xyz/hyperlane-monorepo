import { dirname } from 'path';
import {
  DockerComposeEnvironment,
  GenericContainer,
  Wait,
} from 'testcontainers';
import { fileURLToPath } from 'url';

import { TestChainMetadata } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

export async function runRadixNode(_meta: TestChainMetadata) {
  const composeFilePath = `${__dirname}/radix`;

  console.log('Starting Radix localnet with testcontainers...');

  const environment = await new DockerComposeEnvironment(
    composeFilePath,
    'docker-compose.yml',
  )
    .withProfiles('fullnode', 'network-gateway-image')
    .withWaitStrategy('postgres_db-1', Wait.forHealthCheck())
    .withWaitStrategy('fullnode-1', Wait.forHealthCheck())
    .withWaitStrategy(
      'gateway_api_image-1',
      Wait.forLogMessage(/HealthyAndSynced=1/),
    )
    .withStartupTimeout(180_000) // 3 minutes for all services
    .up();

  console.log('Radix localnet started successfully');

  return environment;
}
