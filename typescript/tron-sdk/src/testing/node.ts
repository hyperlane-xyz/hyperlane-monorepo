import { execSync } from 'child_process';

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

const TRE_IMAGE = 'tronbox/tre';

/**
 * The internal port tronbox/tre listens on (not configurable).
 */
const TRE_CONTAINER_PORT = 9090;

/**
 * Fixed mnemonic passed to tronbox/tre so accounts are deterministic.
 * The derived account 0 private key must match TEST_TRON_PRIVATE_KEY
 * in constants.ts.
 */
const TRE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Result of starting a Tron node, including the container and funded keys.
 */
export interface TronNodeInfo {
  container: StartedTestContainer;
  /** Private keys of accounts pre-funded by TRE (hex, no 0x prefix). */
  privateKeys: string[];
}

/** Run a shell command and return stdout, swallowing errors. */
function shell(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 10_000 }).toString().trim();
  } catch {
    return `<command failed: ${cmd}>`;
  }
}

/** Log Docker environment diagnostics before starting the container. */
function logPreFlightDiagnostics(): void {
  rootLogger.info(
    '[tron-diag] Docker version: ' +
      shell('docker version --format "{{.Server.Version}}"'),
  );
  rootLogger.info(
    '[tron-diag] Docker info (memory): ' +
      shell('docker info --format "{{.MemTotal}}"'),
  );
  rootLogger.info(
    '[tron-diag] Free memory: ' + shell('free -h 2>/dev/null || echo "N/A"'),
  );
  rootLogger.info(
    '[tron-diag] Disk space: ' +
      shell('df -h / 2>/dev/null | tail -1 || echo "N/A"'),
  );

  const imageId = shell(`docker images -q ${TRE_IMAGE}`);
  rootLogger.info(
    `[tron-diag] TRE image cached: ${imageId ? 'yes (' + imageId + ')' : 'no (will pull)'}`,
  );
}

/** Dump diagnostics for a failed container start. */
function logPostFailureDiagnostics(attempt: number): void {
  rootLogger.error(
    `[tron-diag] Container start failed (attempt ${attempt}). Dumping diagnostics...`,
  );

  const ps = shell(
    'docker ps -a --filter ancestor=tronbox/tre --format "{{.ID}} {{.Status}} {{.Ports}}" --no-trunc',
  );
  rootLogger.error('[tron-diag] TRE containers: ' + ps);

  if (!ps || ps.startsWith('<command failed')) return;

  const containerId = ps.split('\n')[0]?.split(' ')[0];
  if (!containerId) return;

  const state = shell(
    `docker inspect --format "{{json .State}}" ${containerId}`,
  );
  rootLogger.error('[tron-diag] Container state: ' + state);

  const ports = shell(
    `docker inspect --format "{{json .NetworkSettings.Ports}}" ${containerId}`,
  );
  rootLogger.error('[tron-diag] Container ports: ' + ports);

  const hostConfig = shell(
    `docker inspect --format "{{json .HostConfig.PortBindings}}" ${containerId}`,
  );
  rootLogger.error('[tron-diag] HostConfig.PortBindings: ' + hostConfig);

  const logs = shell(`docker logs --tail 50 ${containerId} 2>&1`);
  rootLogger.error('[tron-diag] Container logs (last 50 lines):\n' + logs);
}

/**
 * Starts a local Tron node using the tronbox/tre Docker image.
 *
 * Uses host networking when the requested port matches the container's
 * internal port (9090), avoiding testcontainers' hardcoded 10s port
 * binding timeout. Falls back to explicit port mapping otherwise.
 *
 * @param chainMetadata - Test chain metadata configuration
 * @returns Container and pre-funded account private keys
 */
export async function runTronNode(
  chainMetadata: TronTestChainMetadata,
): Promise<TronNodeInfo> {
  rootLogger.info(`Starting Tron node for ${chainMetadata.name}`);
  logPreFlightDiagnostics();

  const useHostNetwork = chainMetadata.port === TRE_CONTAINER_PORT;
  rootLogger.info(
    `[tron-diag] Port config: requested=${chainMetadata.port}, container=${TRE_CONTAINER_PORT}, useHostNetwork=${useHostNetwork}`,
  );

  let attempt = 0;
  const container = await retryAsync(
    async () => {
      attempt++;
      rootLogger.info(`[tron-diag] Starting container attempt ${attempt}`);
      const startTime = Date.now();

      const gc = new GenericContainer(TRE_IMAGE).withEnvironment({
        preapprove: 'allowTvmCompatibleEvm:1',
        mnemonic: TRE_MNEMONIC,
      });

      if (useHostNetwork) {
        gc.withNetworkMode('host');
      } else {
        gc.withExposedPorts({
          container: TRE_CONTAINER_PORT,
          host: chainMetadata.port,
        });
      }

      try {
        const started = await gc
          .withStartupTimeout(120_000)
          .withWaitStrategy(
            Wait.forLogMessage(/TRE now listening on/).withStartupTimeout(
              120_000,
            ),
          )
          .start();

        rootLogger.info(
          `[tron-diag] Container started in ${Date.now() - startTime}ms`,
        );
        return started;
      } catch (err: unknown) {
        const elapsed = Date.now() - startTime;
        const msg = err instanceof Error ? err.message : String(err);
        rootLogger.error(
          `[tron-diag] Container start failed after ${elapsed}ms: ${msg}`,
        );
        logPostFailureDiagnostics(attempt);
        throw err;
      }
    },
    3,
    5000,
  );

  rootLogger.info(
    `Waiting for Tron node to be ready for ${chainMetadata.name}`,
  );
  const privateKeys = await waitForTronNodeReady(chainMetadata.port);

  return { container, privateKeys };
}

/**
 * Stops a Tron node started with runTronNode.
 * Accepts either a StartedTestContainer or a TronNodeInfo.
 */
export async function stopTronNode(
  nodeOrContainer: StartedTestContainer | TronNodeInfo,
): Promise<void> {
  rootLogger.info('Stopping Tron node');
  const container =
    'container' in nodeOrContainer
      ? nodeOrContainer.container
      : nodeOrContainer;
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
 * Checks JSON-RPC, HTTP API, and account funding.
 * Returns the pre-funded private keys.
 */
async function waitForTronNodeReady(port: number): Promise<string[]> {
  const tronUrl = `http://127.0.0.1:${port}`;

  let privateKeys: string[] = [];

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

      // Wait for TRE to fund accounts (happens after node starts mining)
      const resp = await withTimeout(
        fetch(`${tronUrl}/admin/accounts-json`),
        5000,
      );
      const data = (await resp.json()) as { privateKeys: string[] };
      if (!data.privateKeys?.length) {
        throw new Error('No funded accounts yet');
      }
      privateKeys = data.privateKeys;

      rootLogger.info(
        `Tron node ready: JSON-RPC at block ${blockNumber}, HTTP API ok, ${privateKeys.length} funded accounts`,
      );
    },
    1000,
    60,
  );

  return privateKeys;
}
