// eslint-disable-next-line import/no-nodejs-modules
import { type ChildProcess, execSync, spawn } from 'child_process';
// eslint-disable-next-line import/no-nodejs-modules
import { existsSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules
import { homedir } from 'node:os';
// eslint-disable-next-line import/no-nodejs-modules
import { join } from 'node:path';

import { waitUntilReady } from '@hyperlane-xyz/forking-sdk';
import {
  assert,
  isNullish,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { createRpc } from '../rpc.js';

const logger = rootLogger.child({ module: 'surfpool-node' });

export const SURFPOOL_IMAGE = 'surfpool/surfpool:1.5.0';

const DOCKER_INTERNAL_HOST = 'host.docker.internal';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);

export const SurfpoolDatasourceMode = {
  Fork: 'fork',
  Network: 'network',
  Offline: 'offline',
} as const;
export type SurfpoolDatasourceMode =
  (typeof SurfpoolDatasourceMode)[keyof typeof SurfpoolDatasourceMode];

export const SolanaCluster = {
  Mainnet: 'mainnet',
  Devnet: 'devnet',
  Testnet: 'testnet',
} as const;
export type SolanaCluster = (typeof SolanaCluster)[keyof typeof SolanaCluster];

export type SurfpoolDatasource =
  | { mode: typeof SurfpoolDatasourceMode.Fork; rpcUrl: string }
  | { mode: typeof SurfpoolDatasourceMode.Network; network: SolanaCluster }
  | { mode: typeof SurfpoolDatasourceMode.Offline };

export interface SurfpoolAirdrops {
  addresses: string[];
  lamports: bigint;
}

export interface SurfpoolNodeConfig {
  datasource: SurfpoolDatasource;
  rpcPort: number;
  wsPort?: number;
  airdrops?: SurfpoolAirdrops;
  skipSignatureVerification?: boolean;
  skipBlockhashCheck?: boolean;
  image?: string;
  binaryPath?: string;
  keepRunning?: boolean;
}

export interface SurfpoolNode {
  readonly rpcUrl: string;
  kill(): void;
}

const SURFPOOL_BINARY_PATHS = [
  join(homedir(), '.cargo/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function findSurfpool(): string | null {
  for (const basePath of SURFPOOL_BINARY_PATHS) {
    const binaryPath = join(basePath, 'surfpool');
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  }

  try {
    const result = execSync('which surfpool', { encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch (error) {
    logger.debug({ err: error }, 'surfpool not found in PATH');
  }

  return null;
}

function buildSurfpoolArgs(
  config: SurfpoolNodeConfig,
  datasource: SurfpoolDatasource,
  bindHost: string,
): string[] {
  const args = [
    'start',
    '--no-tui',
    '--no-studio',
    '--no-deploy',
    '--host',
    bindHost,
    '--port',
    String(config.rpcPort),
  ];

  if (!isNullish(config.wsPort)) {
    args.push('--ws-port', String(config.wsPort));
  }

  if (datasource.mode === SurfpoolDatasourceMode.Fork) {
    args.push('--rpc-url', datasource.rpcUrl);
  } else if (datasource.mode === SurfpoolDatasourceMode.Network) {
    args.push('--network', datasource.network);
  } else {
    args.push('--offline');
  }

  if (config.skipSignatureVerification) {
    args.push('--skip-signature-verification');
  }
  if (config.skipBlockhashCheck) {
    args.push('--skip-blockhash-check');
  }

  if (config.airdrops && config.airdrops.addresses.length > 0) {
    for (const address of config.airdrops.addresses) {
      args.push('--airdrop', address);
    }
    args.push('--airdrop-amount', config.airdrops.lamports.toString());
  }

  return args;
}

// A datasource pointing at the host loopback is unreachable from inside a
// container; rewrite it so the containerized node can reach the host service.
function rewriteDatasourceForDocker(
  datasource: SurfpoolDatasource,
): SurfpoolDatasource {
  if (datasource.mode !== SurfpoolDatasourceMode.Fork) {
    return datasource;
  }

  const url = new URL(datasource.rpcUrl);
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return datasource;
  }

  url.hostname = DOCKER_INTERNAL_HOST;
  return { mode: SurfpoolDatasourceMode.Fork, rpcUrl: url.toString() };
}

async function startLocalSurfpool(
  config: SurfpoolNodeConfig,
  binaryPath: string,
): Promise<SurfpoolNode> {
  const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');
  const proc: ChildProcess = spawn(binaryPath, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
  });

  proc.on('error', (error) => {
    logger.error({ err: error }, 'surfpool process error');
  });

  const rpcUrl = `http://127.0.0.1:${config.rpcPort}`;

  return {
    rpcUrl,
    kill() {
      if (config.keepRunning) {
        return;
      }
      if (isNullish(proc.exitCode)) {
        proc.kill('SIGTERM');
      }
    },
  };
}

async function startDockerSurfpool(
  config: SurfpoolNodeConfig,
): Promise<SurfpoolNode> {
  const image = config.image ?? SURFPOOL_IMAGE;
  const datasource = rewriteDatasourceForDocker(config.datasource);
  const command = buildSurfpoolArgs(config, datasource, '0.0.0.0');

  const exposedPorts = [config.rpcPort];
  if (!isNullish(config.wsPort)) {
    exposedPorts.push(config.wsPort);
  }

  const builder = new GenericContainer(image)
    .withEntrypoint(['surfpool'])
    .withCommand(command)
    .withExposedPorts(...exposedPorts)
    .withExtraHosts([{ host: DOCKER_INTERNAL_HOST, ipAddress: 'host-gateway' }])
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000);

  const container: StartedTestContainer = await retryAsync(
    () => builder.start(),
    3,
    5000,
  );

  const rpcUrl = `http://${container.getHost()}:${container.getMappedPort(config.rpcPort)}`;

  return {
    rpcUrl,
    kill() {
      if (config.keepRunning) {
        return;
      }
      void container.stop().catch((error) => {
        logger.debug({ err: error }, 'surfpool container stop failed');
      });
    },
  };
}

async function waitForSolanaRpcReady(rpcUrl: string): Promise<void> {
  const rpc = createRpc(rpcUrl);
  await waitUntilReady(
    async () => {
      const health = await rpc.getHealth().send();
      assert(health === 'ok', `surfpool RPC not healthy: ${health}`);
    },
    { attempts: 60, baseRetryMs: 1000 },
  );
}

/**
 * Starts a surfpool node and waits for its RPC to be ready. Prefers a local
 * `surfpool` binary if present on PATH, otherwise falls back to a Docker image
 * via testcontainers.
 */
export async function runSurfpoolNode(
  config: SurfpoolNodeConfig,
): Promise<SurfpoolNode> {
  const localBinary = config.binaryPath ?? findSurfpool();

  let node: SurfpoolNode;
  if (localBinary) {
    logger.info(`Using local surfpool binary: ${localBinary}`);
    node = await startLocalSurfpool(config, localBinary);
  } else {
    logger.info(
      `Using Docker image for surfpool: ${config.image ?? SURFPOOL_IMAGE}`,
    );
    node = await startDockerSurfpool(config);
  }

  await waitForSolanaRpcReady(node.rpcUrl);

  return node;
}
