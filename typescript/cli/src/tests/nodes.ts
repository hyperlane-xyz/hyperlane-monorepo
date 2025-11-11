import { dirname } from 'path';
import {
  DockerComposeEnvironment,
  GenericContainer,
  Wait,
} from 'testcontainers';
import { fileURLToPath } from 'url';

import { assert, sleep } from '@hyperlane-xyz/utils';

import { TestChainMetadata } from './constants.js';
import { deployHyperlaneRadixPackageDefinition } from './radix/utils.js';

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

export async function runRadixNode(
  chainMetadata: TestChainMetadata,
  hyperlanePackageArtifacts: {
    code: Uint8Array;
    packageDefinition: Uint8Array;
  },
) {
  const gatewayUrl = chainMetadata.gatewayUrls?.[0]?.http;
  assert(
    gatewayUrl,
    `At least one gateway url should be defined in the ${chainMetadata.name} chain metadata`,
  );
  const gatewayPort = new URL(gatewayUrl).port;

  const environment = await new DockerComposeEnvironment(
    `${__dirname}/radix`,
    'docker-compose.yml',
  )
    .withEnvironment({
      RADIX_CORE_PORT: chainMetadata.rpcPort.toString(),
      RADIX_GATEWAY_PORT: gatewayPort,
    })
    .withProfiles('fullnode', 'network-gateway-image')
    .withWaitStrategy('postgres_db-1', Wait.forHealthCheck())
    .withWaitStrategy('fullnode-1', Wait.forHealthCheck())
    .withWaitStrategy(
      'gateway_api_image-1',
      Wait.forLogMessage(/HealthyAndSynced=1/),
    )
    .up();

  // Wait 10 sec to give time to the gateway api to sync
  console.log(`Waiting on the gateway API to sync for ${chainMetadata.name}`);
  await sleep(10_000);

  await deployHyperlaneRadixPackageDefinition(
    chainMetadata,
    hyperlanePackageArtifacts,
  );

  return environment;
}
