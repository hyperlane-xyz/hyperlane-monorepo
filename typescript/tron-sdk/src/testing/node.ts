/* eslint-disable import/no-nodejs-modules */
import { dirname, join } from 'path';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import { fileURLToPath } from 'url';

import { retryAsync, rootLogger, sleep } from '@hyperlane-xyz/utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Extended test chain metadata for Tron
 */
export interface TronTestChainMetadata {
  name: string;
  chainId: number;
  domainId: number;
  rpcPort: number; // JSON-RPC port (8545)
  httpPort: number; // HTTP API port (8090)
}

/**
 * Get the path to the local-node directory
 */
export function getLocalNodeDir(): string {
  return join(__dirname, '..', '..', 'local-node');
}

/**
 * Starts a local Tron node using Docker Compose via testcontainers
 *
 * @param chainMetadata - Test chain metadata configuration
 * @returns The DockerComposeEnvironment instance
 */
export async function runTronNode(
  chainMetadata: TronTestChainMetadata,
): Promise<StartedDockerComposeEnvironment> {
  rootLogger.info(`Starting Tron node for ${chainMetadata.name}`);

  // Retry docker-compose up to handle transient Docker registry errors in CI
  const environment = await retryAsync<StartedDockerComposeEnvironment>(
    async () =>
      new DockerComposeEnvironment(getLocalNodeDir(), 'docker-compose.yml')
        .withEnvironment({
          TRON_JSON_RPC_PORT: chainMetadata.rpcPort.toString(),
          TRON_HTTP_PORT: chainMetadata.httpPort.toString(),
        })
        // Wait for JSON-RPC port to be listening
        .withWaitStrategy('tron-local-1', Wait.forListeningPorts())
        .up(),
    3, // maxRetries
    5000, // baseRetryMs
  );

  // Wait for the node to fully initialize (blocks being produced)
  rootLogger.info(
    `Waiting for Tron node to initialize for ${chainMetadata.name}`,
  );
  await sleep(30_000);

  return environment;
}

/**
 * Stops a Tron node started with runTronNode
 */
export async function stopTronNode(
  environment: StartedDockerComposeEnvironment,
): Promise<void> {
  rootLogger.info('Stopping Tron node');
  await environment.down();
}
