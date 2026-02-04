/* eslint-disable import/no-nodejs-modules */
import { dirname, join } from 'path';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
  Wait,
} from 'testcontainers';
import { fileURLToPath } from 'url';

import { pollAsync, retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import { TronJsonRpcProvider } from '../ethers/TronJsonRpcProvider.js';

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

  // Poll until the node is ready to process transactions
  rootLogger.info(
    `Waiting for Tron node to be ready for ${chainMetadata.name}`,
  );
  await waitForTronNodeReady(chainMetadata.rpcPort);

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

/**
 * Poll until the Tron node is ready to process transactions.
 * Checks eth_blockNumber to verify the node is producing blocks.
 */
async function waitForTronNodeReady(rpcPort: number): Promise<void> {
  const provider = new TronJsonRpcProvider(`http://127.0.0.1:${rpcPort}`);

  await pollAsync(
    async () => {
      const blockNumber = await provider.getBlockNumber();
      if (blockNumber === 0) {
        throw new Error('Block number is 0, node not ready');
      }
      rootLogger.info(`Tron node ready at block ${blockNumber}`);
      return blockNumber;
    },
    1000, // poll every 1 second
    60, // max 60 attempts (60 seconds)
  );
}
