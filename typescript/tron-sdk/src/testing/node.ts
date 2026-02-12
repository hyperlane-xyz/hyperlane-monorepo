import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { TronWeb } from 'tronweb';

import { pollAsync, retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import { TronJsonRpcProvider } from '../ethers/TronJsonRpcProvider.js';

/**
 * Test chain metadata for Tron (tronbox/tre uses a single port for all APIs)
 */
export interface TronTestChainMetadata {
  name: string;
  chainId: number;
  domainId: number;
  port: number; // Single port for HTTP API + JSON-RPC (/jsonrpc)
}

/**
 * The internal port tronbox/tre listens on (not configurable).
 */
const TRE_CONTAINER_PORT = 9090;

/**
 * Starts a local Tron node using the tronbox/tre Docker image.
 *
 * Uses host networking when the requested port matches the container's
 * internal port (9090), avoiding testcontainers' hardcoded 10s port
 * binding timeout. Falls back to explicit port mapping otherwise.
 *
 * @param chainMetadata - Test chain metadata configuration
 * @returns The started container instance
 */
export async function runTronNode(
  chainMetadata: TronTestChainMetadata,
): Promise<StartedTestContainer> {
  rootLogger.info(`Starting Tron node for ${chainMetadata.name}`);

  const useHostNetwork = chainMetadata.port === TRE_CONTAINER_PORT;

  const container = await retryAsync(
    () => {
      const gc = new GenericContainer('tronbox/tre').withEnvironment({
        // Enable full EVM-compatible opcode support
        preapprove: 'allowTvmCompatibleEvm:1',
      });

      if (useHostNetwork) {
        // Host networking: port 9090 is directly accessible, no port
        // mapping needed. Avoids testcontainers' 10s port bind timeout.
        gc.withNetworkMode('host');
      } else {
        gc.withExposedPorts({
          container: TRE_CONTAINER_PORT,
          host: chainMetadata.port,
        });
      }

      return gc
        .withStartupTimeout(120_000)
        .withWaitStrategy(
          Wait.forLogMessage(/TRE now listening on/).withStartupTimeout(
            120_000,
          ),
        )
        .start();
    },
    3, // maxRetries
    5000, // baseRetryMs
  );

  // Poll until the node is ready to process transactions
  rootLogger.info(
    `Waiting for Tron node to be ready for ${chainMetadata.name}`,
  );
  await waitForTronNodeReady(chainMetadata.port);

  return container;
}

/**
 * Stops a Tron node started with runTronNode
 */
export async function stopTronNode(
  container: StartedTestContainer,
): Promise<void> {
  rootLogger.info('Stopping Tron node');
  await container.stop();
}

/**
 * Poll until the Tron node is ready to process transactions.
 * Checks both JSON-RPC (eth_blockNumber) and HTTP API (wallet/getblock).
 */
async function waitForTronNodeReady(port: number): Promise<void> {
  const tronUrl = `http://127.0.0.1:${port}`;
  const provider = new TronJsonRpcProvider(tronUrl);
  const tronweb = new TronWeb({ fullHost: tronUrl });

  await pollAsync(
    async () => {
      const [blockNumber, block] = await Promise.all([
        provider.getBlockNumber(),
        tronweb.trx.getCurrentBlock(),
      ]);
      if (blockNumber === 0) {
        throw new Error('Block number is 0, node not ready');
      }
      if (!block.blockID) {
        throw new Error('HTTP API returned invalid block data');
      }
      rootLogger.info(
        `Tron node ready: JSON-RPC at block ${blockNumber}, HTTP API ok`,
      );
    },
    1000, // poll every 1 second
    60, // max 60 attempts (60 seconds)
  );
}
