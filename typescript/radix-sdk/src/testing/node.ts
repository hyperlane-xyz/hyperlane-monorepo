/* eslint-disable import/no-nodejs-modules */
import { dirname, join } from 'path';
import { DockerComposeEnvironment, Wait } from 'testcontainers';
/* eslint-disable import/no-nodejs-modules */
import { fileURLToPath } from 'url';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, rootLogger, sleep } from '@hyperlane-xyz/utils';

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
 * @returns The DockerComposeEnvironment instance
 */
export async function runRadixNode(
  chainMetadata: TestChainMetadata,
  hyperlanePackageArtifacts: RadixContractArtifacts,
  privateKey?: string,
) {
  const gatewayUrl = chainMetadata.gatewayUrls?.[0]?.http;
  assert(
    gatewayUrl,
    `At least one gateway url should be defined in the ${chainMetadata.name} chain metadata`,
  );
  const gatewayPort = new URL(gatewayUrl).port;

  const environment = await new DockerComposeEnvironment(
    // move back to the root of this package
    join(__dirname, '..', '..'),
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
