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
        preapprove: 'allowTvmCompatibleEvm:1',
      });

      if (useHostNetwork) {
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
    3,
    5000,
  );

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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms`)),
      ms,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Poll until the Tron node is ready to process transactions.
 * Checks both JSON-RPC (eth_blockNumber) and HTTP API (wallet/getblock).
 */
async function waitForTronNodeReady(port: number): Promise<void> {
  const tronUrl = `http://127.0.0.1:${port}`;

  await pollAsync(
    async () => {
      // Create fresh instances each attempt — the TRE proxy accepts TCP
      // connections before internal services are ready, causing requests
      // to hang. A hung ethers provider poisons all subsequent calls.
      const provider = new TronJsonRpcProvider(tronUrl);
      const tronweb = new TronWeb({ fullHost: tronUrl });

      const [blockNumber, block] = await withTimeout(
        Promise.all([provider.getBlockNumber(), tronweb.trx.getCurrentBlock()]),
        5000,
      );
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
    1000,
    60,
  );
}
