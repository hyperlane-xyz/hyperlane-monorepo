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
import { createServer } from 'node:net';
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

// Install guidance surfaced whenever a compatible `surfpool` binary is missing.
// Points at the pinned, checksum-verified release rather than the mutable
// `run.surfpool.run` installer, so an operator (or agent) never pipes remote
// code to a shell.
const SURFPOOL_INSTALL_GUIDANCE =
  `Install a pinned surfpool ${SURFPOOL_MIN_VERSION}+ release from ` +
  'https://github.com/txtx/surfpool/releases and verify its SHA-256 checksum; ' +
  'do not pipe the mutable run.surfpool.run installer to a shell.';

// Env var surfpool reads for its fork datasource. Passing the (possibly
// credential-bearing) upstream URL this way keeps it out of the process argv.
export const SURFPOOL_DATASOURCE_RPC_URL_ENV = 'SURFPOOL_DATASOURCE_RPC_URL';

// Per-probe RPC timeout so a single hung request fails fast and the bounded
// readiness loop can continue.
const RPC_PROBE_TIMEOUT_MS = 5000;

// Cap on the retained tail of surfpool stderr, surfaced in exit errors.
const STDERR_TAIL_MAX = 8192;

const REDACTED_DATASOURCE_URL = '<redacted-datasource-url>';

// URL userinfo credentials (scheme://user:pass@host). A defense-in-depth
// backstop that scrubs a reformatted/percent-encoded credential the exact
// datasource-URL match would miss.
const URL_USERINFO_CREDENTIALS_RE = /\/\/[^/@\s]+:[^/@\s]+@/g;

/**
 * Scrubs secrets from surfpool stderr before it is embedded in a surfaced error.
 * surfpool prints stderr verbatim (not shell-escaped), so the known
 * credential-bearing datasource URL is removed by exact-string replacement;
 * stripping URL userinfo credentials is a backstop for any other credential URL.
 */
export function redactSurfpoolStderr(
  detail: string,
  datasourceUrl?: string,
): string {
  const withoutDatasource = isNullish(datasourceUrl)
    ? detail
    : detail.split(datasourceUrl).join(REDACTED_DATASOURCE_URL);
  return withoutDatasource.replace(
    URL_USERINFO_CREDENTIALS_RE,
    '//<redacted>@',
  );
}

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
  /**
   * WebSocket port. Omitting it disables the ws-port collision preflight, so
   * surfpool binds its default ws port unpreflighted (reintroducing the
   * collision race for that port).
   */
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

interface SurfpoolVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): SurfpoolVersion | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function meetsMinVersion(
  version: SurfpoolVersion,
  min: SurfpoolVersion,
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

  if (datasource.mode === SurfpoolDatasourceMode.Network) {
    args.push('--network', datasource.network);
  } else if (datasource.mode === SurfpoolDatasourceMode.Offline) {
    args.push('--offline');
  }
  // Fork mode: the datasource URL is passed via the SURFPOOL_DATASOURCE_RPC_URL
  // env (see buildSurfpoolDatasourceEnv) rather than argv.

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

/**
 * Spawn env carrying surfpool's fork datasource URL. Empty for network/offline
 * datasources, which take no credentials and are expressed via argv flags.
 */
export function buildSurfpoolDatasourceEnv(
  datasource: SurfpoolDatasource,
): Record<string, string> {
  if (datasource.mode !== SurfpoolDatasourceMode.Fork) {
    return {};
  }
  return { [SURFPOOL_DATASOURCE_RPC_URL_ENV]: datasource.rpcUrl };
}

/**
 * Per-attempt abort signal that fires after `timeoutMs`, or immediately when
 * `parent` aborts (so a caller cancelling the readiness loop also cancels the
 * in-flight probe request). Composed manually to stay usable on Node <17, which
 * lacks `AbortSignal.timeout`/`AbortSignal.any`. `dispose` clears the timer and
 * detaches the parent listener so nothing lingers between attempts.
 */
export function probeTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const dispose = (): void => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  };
  return { signal: controller.signal, dispose };
}

export async function waitForSolanaRpcReady(
  rpcUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  const rpc = createRpc(rpcUrl);
  await waitUntilReady(
    async () => {
      const { signal: probeSignal, dispose } = probeTimeoutSignal(
        RPC_PROBE_TIMEOUT_MS,
        signal,
      );
      try {
        const health = await rpc.getHealth().send({ abortSignal: probeSignal });
        assert(health === 'ok', `surfpool RPC not healthy: ${health}`);
      } finally {
        dispose();
      }
    },
    { attempts: 60, baseRetryMs: 1000, signal },
  );
}

/**
 * Rejects if `port` on 127.0.0.1 is already bound. A bind-test up front closes
 * the port-collision race: proving RPC health after spawn can otherwise pass
 * against an unrelated node already listening on the port, before our freshly
 * spawned child fails with EADDRINUSE.
 */
export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: Error) => {
      const code = 'code' in error ? error.code : undefined;
      reject(
        code === 'EADDRINUSE'
          ? new Error(`port ${port} is already in use`)
          : error,
      );
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Readiness probe injected into {@link startLocalSurfpool}. Defaults to
 * {@link waitForSolanaRpcReady}; tests override it (e.g. with a never-settling
 * probe) to exercise the spawn-error / exit races without a live RPC.
 */
export type WaitForRpcReady = (
  rpcUrl: string,
  signal?: AbortSignal,
) => Promise<void>;

// A single process-level `exit` hook kills every still-running fork, rather than
// one listener per fork — which would trip MaxListenersExceededWarning past ten
// forks and retain each child's closure until process exit. A fork joins the
// registry on start and leaves when it is killed or its child exits.
const runningForkKills = new Set<() => void>();
let forkExitHookInstalled = false;

function trackForkExit(killFork: () => void): () => void {
  runningForkKills.add(killFork);
  if (!forkExitHookInstalled) {
    forkExitHookInstalled = true;
    process.once('exit', () => {
      for (const kill of Array.from(runningForkKills)) {
        kill();
      }
    });
  }
  return () => {
    runningForkKills.delete(killFork);
  };
}

export async function startLocalSurfpool(
  config: SurfpoolNodeConfig,
  binaryPath: string,
  waitForRpcReady: WaitForRpcReady = waitForSolanaRpcReady,
): Promise<{ node: SurfpoolNode; waitForReady: () => Promise<void> }> {
  // Fail fast if any bind port is taken, before spawning, so we never treat
  // another process's RPC as our fork and never spawn a doomed child that would
  // fail to bind an occupied ws port.
  await assertPortAvailable(config.rpcPort);
  if (!isNullish(config.wsPort)) {
    await assertPortAvailable(config.wsPort);
  }

  const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');
  // Suppress surfpool's own logs (its default ./.surfpool/logs dir would clutter
  // the working dir); startup/bind failures still surface on stderr, drained below.
  args.push('--log-level', 'none');
  const proc: ChildProcess = spawn(binaryPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
    env: { ...process.env, ...buildSurfpoolDatasourceEnv(config.datasource) },
  });

  // Drain stderr into a bounded tail; reading it also keeps the pipe from
  // filling and blocking the child.
  let stderrTail = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX);
  });

  const rpcUrl = `http://127.0.0.1:${config.rpcPort}`;
  const datasourceUrl =
    config.datasource.mode === SurfpoolDatasourceMode.Fork
      ? config.datasource.rpcUrl
      : undefined;

  const kill = (): void => {
    // Leave the process-exit registry whenever the child is gone (killed here,
    // or exited/errored below) so a dead fork never keeps being tracked.
    untrackFork();
    if (config.keepRunning) {
      return;
    }
    if (isNullish(proc.exitCode)) {
      proc.kill('SIGTERM');
    }
  };
  const untrackFork = trackForkExit(kill);

  // A failed spawn (e.g. ENOENT) emits `error` with no guaranteed `exit`, so the
  // readiness race must reject on it — otherwise readiness burns the full probe
  // timeout and reports a misleading RPC error instead of the real spawn failure.
  // Attach synchronously here so no `error` can fire before a listener exists.
  const errored = new Promise<never>((_, reject) => {
    proc.once('error', (error: Error) => {
      untrackFork();
      logger.debug({ err: error }, 'surfpool process error');
      reject(error);
    });
  });
  // A spawn error arriving after readiness (or exit) has already settled the race
  // must not surface as an unhandled rejection.
  errored.catch(() => {});

  // Capture the child's exit synchronously after spawn rather than lazily inside
  // `waitForReady`: `exit` is not replayed, so a caller that waits after the
  // child has already exited must still observe it instead of polling to the
  // readiness bound. Rejecting here also drops the fork from the exit registry.
  const exited = new Promise<never>((_, reject) => {
    proc.once('exit', (code, signal) => {
      untrackFork();
      const detail = redactSurfpoolStderr(stderrTail.trim(), datasourceUrl);
      reject(
        new Error(
          `surfpool exited before its RPC was ready (code=${code}, signal=${signal})` +
            (detail ? `: ${detail}` : ''),
        ),
      );
    });
  });
  // A later exit (e.g. on kill once readiness has won) must not surface as an
  // unhandled rejection after the race settles.
  exited.catch(() => {});

  const waitForReady = async (): Promise<void> => {
    // Abort the readiness probe the instant the race settles so no retry timer
    // keeps polling a dead port after an early exit or spawn error wins.
    const controller = new AbortController();
    try {
      await Promise.race([
        waitForRpcReady(rpcUrl, controller.signal),
        exited,
        errored,
      ]);
    } finally {
      controller.abort();
    }
  };

  return { node: { rpcUrl, kill }, waitForReady };
}

// A caller-supplied binary is an explicit choice, so failures name the specific
// cause (missing / not executable / too old) instead of the generic auto-
// discovery "no compatible binary" message, which would otherwise report the
// substituted "unknown" version and hide the real problem.
function resolveExplicitBinary(
  binaryPath: string,
  min: SurfpoolVersion,
): { path: string; version: string } {
  assert(existsSync(binaryPath), `surfpool binary not found at ${binaryPath}`);

  const version = getSurfpoolVersion(binaryPath);
  assert(
    version,
    `surfpool binary at ${binaryPath} could not be run (check it is executable and 'surfpool --version' works).`,
  );

  const parsed = parseVersion(version);
  assert(
    parsed && meetsMinVersion(parsed, min),
    `surfpool at ${binaryPath} is version ${version} but ${SURFPOOL_MIN_VERSION}+ is required. ` +
      SURFPOOL_INSTALL_GUIDANCE,
  );

  return { path: binaryPath, version };
}

function resolveDiscoveredBinary(min: SurfpoolVersion): {
  path: string;
  version: string;
} {
  const candidates = findSurfpoolCandidates();
  const match = candidates.find((candidate) => {
    const parsed = parseVersion(candidate.version);
    return parsed !== null && meetsMinVersion(parsed, min);
  });

  assert(
    match,
    candidates.length === 0
      ? `surfpool ${SURFPOOL_MIN_VERSION}+ is required but no surfpool binary was found on PATH. ` +
          SURFPOOL_INSTALL_GUIDANCE
      : `surfpool ${SURFPOOL_MIN_VERSION}+ is required but only found version(s) ` +
          `${candidates.map((c) => c.version).join(', ')}. ` +
          SURFPOOL_INSTALL_GUIDANCE,
  );

  return match;
}

/**
 * Starts a surfpool node from a locally-installed `surfpool` binary (version
 * {@link SURFPOOL_MIN_VERSION} or newer) and waits for its RPC to be ready.
 * An explicit `config.binaryPath` is validated up front with a specific error;
 * otherwise the PATH is searched and an install-guidance error is thrown if no
 * compatible binary is found.
 */
export async function runSurfpoolNode(
  config: SurfpoolNodeConfig,
): Promise<SurfpoolNode> {
  const min = parseVersion(SURFPOOL_MIN_VERSION);
  assert(min, `Invalid SURFPOOL_MIN_VERSION: ${SURFPOOL_MIN_VERSION}`);

  const match = config.binaryPath
    ? resolveExplicitBinary(config.binaryPath, min)
    : resolveDiscoveredBinary(min);

  logger.debug(
    `Using local surfpool binary: ${match.path} (v${match.version})`,
  );
  const { node, waitForReady } = await startLocalSurfpool(config, match.path);
  try {
    await waitForReady();
  } catch (error: unknown) {
    node.kill();
    throw error;
  }
  return node;
}
