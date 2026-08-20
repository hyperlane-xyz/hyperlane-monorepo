/* eslint-disable import/no-nodejs-modules */
import { dirname, join } from 'path';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
/* eslint-disable import/no-nodejs-modules */
import { fileURLToPath } from 'url';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, retryAsync, rootLogger, sleep } from '@hyperlane-xyz/utils';

import {
  RadixContractArtifacts,
  deployHyperlaneRadixPackage,
} from './setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Starts a local Radix node using Docker Compose and deploys the Hyperlane package
 *
 * @param chainMetadata - Test chain metadata configuration
 * @param hyperlanePackageArtifacts - Compiled Radix contract artifacts (WASM + RPD)
 * @param privateKey - Optional private key for deployment (defaults to test key)
 * @param additionalChainMetadata - Additional test chains sharing the same node
 * @returns The DockerComposeEnvironment instance
 */
export async function runRadixNode(
  chainMetadata: TestChainMetadata,
  hyperlanePackageArtifacts: RadixContractArtifacts,
  privateKey?: string,
  additionalChainMetadata: TestChainMetadata[] = [],
) {
  const gatewayUrl = chainMetadata.gatewayUrls?.[0]?.http;
  assert(
    gatewayUrl,
    `At least one gateway url should be defined in the ${chainMetadata.name} chain metadata`,
  );
  // Retry docker-compose up to handle transient Docker registry 503 errors in CI
  const environment = await retryAsync<StartedDockerComposeEnvironment>(
    async () =>
      new DockerComposeEnvironment(
        // move back to the root of this package
        join(__dirname, '..', '..'),
        'docker-compose.yml',
      )
        .withProfiles('fullnode', 'network-gateway-image')
        .withWaitStrategy('postgres_db-1', Wait.forHealthCheck())
        .withWaitStrategy('fullnode-1', Wait.forHealthCheck())
        .withWaitStrategy(
          'gateway_api_image-1',
          Wait.forLogMessage(/HealthyAndSynced=1/),
        )
        .up(),
    3, // maxRetries
    5000, // baseRetryMs
  );

  const rpcPort = environment.getContainer('fullnode-1').getMappedPort(3333);
  const gatewayPort = environment
    .getContainer('gateway_api_image-1')
    .getMappedPort(8080);

  for (const metadata of [chainMetadata, ...additionalChainMetadata]) {
    metadata.rpcPort = rpcPort;
    metadata.restPort = rpcPort;
    metadata.rpcUrl = `http://127.0.0.1:${rpcPort}`;
    assert(
      metadata.rpcUrls?.[0],
      `At least one rpc url should be defined in the ${metadata.name} chain metadata`,
    );
    metadata.rpcUrls[0].http = `${metadata.rpcUrl}/core`;
    assert(
      metadata.gatewayUrls?.[0],
      `At least one gateway url should be defined in the ${metadata.name} chain metadata`,
    );
    metadata.gatewayUrls[0].http = `http://127.0.0.1:${gatewayPort}`;
  }

  // Wait 10 sec to give time to the gateway api to sync
  rootLogger.info(
    `Waiting on the gateway API to sync for ${chainMetadata.name}`,
  );
  await sleep(10_000);

  await deployHyperlaneRadixPackage(
    chainMetadata,
    hyperlanePackageArtifacts,
    privateKey,
  );

  return environment;
}
