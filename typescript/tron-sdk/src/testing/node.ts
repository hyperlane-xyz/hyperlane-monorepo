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
  await waitForTronNodeReady(chainMetadata.rpcPort, chainMetadata.httpPort);

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
 * Checks both JSON-RPC (eth_blockNumber) and HTTP API (wallet/getblock).
 */
async function waitForTronNodeReady(
  rpcPort: number,
  httpPort: number,
): Promise<void> {
  const provider = new TronJsonRpcProvider(`http://127.0.0.1:${rpcPort}`);

  // Wait for JSON-RPC to be ready
  await pollAsync(
    async () => {
      const blockNumber = await provider.getBlockNumber();
      if (blockNumber === 0) {
        throw new Error('Block number is 0, node not ready');
      }
      rootLogger.info(`Tron JSON-RPC ready at block ${blockNumber}`);
      return blockNumber;
    },
    1000, // poll every 1 second
    60, // max 60 attempts (60 seconds)
  );

  // Wait for HTTP API to be ready (required for TronWeb transaction building)
  await pollAsync(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${httpPort}/wallet/getblock`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ detail: false }),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP API not ready: ${response.status}`);
      }
      const data = await response.json();
      if (!data.blockID) {
        throw new Error('HTTP API returned invalid block data');
      }
      rootLogger.info(`Tron HTTP API ready`);
      return data;
    },
    1000, // poll every 1 second
    60, // max 60 attempts (60 seconds)
  );
}
