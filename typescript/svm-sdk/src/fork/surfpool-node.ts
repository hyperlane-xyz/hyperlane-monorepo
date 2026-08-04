// eslint-disable-next-line import/no-nodejs-modules
import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
} from 'child_process';
// eslint-disable-next-line import/no-nodejs-modules
import { existsSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules
import { homedir } from 'node:os';
// eslint-disable-next-line import/no-nodejs-modules
import { join } from 'node:path';

import { waitUntilReady } from '@hyperlane-xyz/forking-sdk';
import { assert, isNullish, rootLogger } from '@hyperlane-xyz/utils';

import { createRpc } from '../rpc.js';

const logger = rootLogger.child({ module: 'surfpool-node' });

// Minimum acceptable local `surfpool` version; aligned with the docker image
// `surfpool/surfpool:1.5.0` used by the container runner in test infra.
export const SURFPOOL_MIN_VERSION = '1.5.0';

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

export type SurfpoolNodeRunner = (
  config: SurfpoolNodeConfig,
) => Promise<SurfpoolNode>;

const SURFPOOL_BINARY_PATHS = [
  join(homedir(), '.cargo/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function meetsMinVersion(
  version: { major: number; minor: number; patch: number },
  min: { major: number; minor: number; patch: number },
): boolean {
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

function getSurfpoolVersion(binaryPath: string): string | null {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
    });
    const match = output.match(/surfpool\s+(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch (error) {
    logger.debug(
      { err: error },
      `failed to get surfpool version at ${binaryPath}`,
    );
    return null;
  }
}

function findSurfpoolCandidates(): Array<{ path: string; version: string }> {
  const candidates: Array<{ path: string; version: string }> = [];

  for (const basePath of SURFPOOL_BINARY_PATHS) {
    const binaryPath = join(basePath, 'surfpool');
    if (existsSync(binaryPath)) {
      const version = getSurfpoolVersion(binaryPath);
      if (version) {
        candidates.push({ path: binaryPath, version });
      }
    }
  }

  try {
    const result = execSync('which surfpool', { encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) {
      const version = getSurfpoolVersion(result);
      if (version && !candidates.some((c) => c.path === result)) {
        candidates.push({ path: result, version });
      }
    }
  } catch (error) {
    logger.debug({ err: error }, 'surfpool not found in PATH');
  }

  return candidates;
}

export function buildSurfpoolArgs(
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

export async function waitForSolanaRpcReady(rpcUrl: string): Promise<void> {
  const rpc = createRpc(rpcUrl);
  await waitUntilReady(
    async () => {
      const health = await rpc.getHealth().send();
      assert(health === 'ok', `surfpool RPC not healthy: ${health}`);
    },
    { attempts: 60, baseRetryMs: 1000 },
  );
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

/**
 * Starts a surfpool node from a locally-installed `surfpool` binary (version
 * {@link SURFPOOL_MIN_VERSION} or newer) and waits for its RPC to be ready.
 * Throws with install guidance if no compatible binary is found.
 */
export async function runSurfpoolNode(
  config: SurfpoolNodeConfig,
): Promise<SurfpoolNode> {
  const min = parseVersion(SURFPOOL_MIN_VERSION);
  assert(min, `Invalid SURFPOOL_MIN_VERSION: ${SURFPOOL_MIN_VERSION}`);

  const candidates = config.binaryPath
    ? [
        {
          path: config.binaryPath,
          version: getSurfpoolVersion(config.binaryPath) ?? 'unknown',
        },
      ]
    : findSurfpoolCandidates();

  const match = candidates.find((candidate) => {
    const parsed = parseVersion(candidate.version);
    return parsed !== null && meetsMinVersion(parsed, min);
  });

  assert(
    match,
    candidates.length === 0
      ? `surfpool ${SURFPOOL_MIN_VERSION}+ is required but no surfpool binary was found on PATH. ` +
          'Install it: curl -sSfL https://run.surfpool.run/ | bash ' +
          '(or download from https://github.com/txtx/surfpool/releases).'
      : `surfpool ${SURFPOOL_MIN_VERSION}+ is required but only found version(s) ` +
          `${candidates.map((c) => c.version).join(', ')}. ` +
          'Upgrade it: curl -sSfL https://run.surfpool.run/ | bash.',
  );

  logger.info(`Using local surfpool binary: ${match.path} (v${match.version})`);
  const node = await startLocalSurfpool(config, match.path);
  await waitForSolanaRpcReady(node.rpcUrl);
  return node;
}
