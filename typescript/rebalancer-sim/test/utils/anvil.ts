import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';

import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { retryAsync } from '@hyperlane-xyz/utils';

const CONTAINER_PORT = 8545; // Port inside the container (fixed)
const DEFAULT_CHAIN_ID = 31337;
const LOCAL_ANVIL_HOST = '127.0.0.1';
const LOCAL_ANVIL_STARTUP_TIMEOUT_MS = 30_000;
const LOCAL_ANVIL_STOP_TIMEOUT_MS = 5_000;
const CONTAINER_RUNTIME_UNAVAILABLE_PATTERNS = [
  /could not find a working container runtime strategy/i,
  /no docker client strategy found/i,
  /cannot connect to the docker daemon/i,
  /permission denied while trying to connect to the docker daemon socket/i,
  /dial unix .*docker\.sock/i,
  /failed to connect to .*docker\.sock/i,
  /connect econnrefused .*docker\.sock/i,
  /npipe:.*docker_engine/i,
  /open \/\/\.\/pipe\/docker_engine/i,
];

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      // Ignore JSON serialization failures and fall back to String conversion.
    }
  }

  return String(error);
}

let hasLoggedLocalFallback = false;

/**
 * Start an Anvil container using testcontainers.
 * Uses dynamic port assignment - testcontainers picks an available host port.
 *
 * @returns The started container. Use container.getMappedPort(8545) to get the host port.
 */
export async function startAnvilContainer(
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<StartedTestContainer> {
  return retryAsync(
    () =>
      new GenericContainer('ghcr.io/foundry-rs/foundry:latest')
        .withEntrypoint([
          'anvil',
          '--host',
          '0.0.0.0',
          '-p',
          CONTAINER_PORT.toString(),
          '--chain-id',
          chainId.toString(),
        ])
        .withExposedPorts(CONTAINER_PORT) // Dynamic host port assignment
        .withWaitStrategy(Wait.forLogMessage(/Listening on/))
        .start(),
    3, // maxRetries
    5000, // baseRetryMs
  );
}

/**
 * Get the RPC URL for a started anvil container.
 */
export function getAnvilRpcUrl(container: StartedTestContainer): string {
  const host = container.getHost();
  const port = container.getMappedPort(CONTAINER_PORT);
  return `http://${host}:${port}`;
}

interface StartedAnvil {
  rpc: string;
  stop: () => Promise<void>;
}

export function formatLocalAnvilStartError(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException | undefined;
  if (nodeError?.code === 'ENOENT') {
    return 'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.';
  }

  const message = getErrorMessage(error);
  return `Failed to start local anvil: ${message}`;
}

function extractErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (current instanceof Error) {
      messages.push(current.message);

      const cause = (current as { cause?: unknown }).cause;
      if (cause !== undefined) queue.push(cause);

      if (current instanceof AggregateError) {
        for (const nestedError of current.errors) {
          queue.push(nestedError);
        }
      }

      continue;
    }

    if (
      typeof current === 'object' &&
      current !== null &&
      'message' in current &&
      typeof (current as { message?: unknown }).message === 'string'
    ) {
      messages.push((current as { message: string }).message);

      const cause = (current as { cause?: unknown }).cause;
      if (cause !== undefined) queue.push(cause);

      const nestedErrors = (current as { errors?: unknown }).errors;
      if (Array.isArray(nestedErrors)) {
        for (const nestedError of nestedErrors) {
          queue.push(nestedError);
        }
      }

      continue;
    }

    messages.push(String(current));
  }

  return messages;
}

export function isContainerRuntimeUnavailable(error: unknown): boolean {
  return extractErrorMessages(error).some((message) =>
    CONTAINER_RUNTIME_UNAVAILABLE_PATTERNS.some((matcher) =>
      matcher.test(message),
    ),
  );
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);

    server.listen(0, LOCAL_ANVIL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate local port')));
        return;
      }

      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function stopLocalAnvilProcess(
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (process.killed || process.exitCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.removeListener('exit', onExit);
      resolve();
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.removeListener('exit', onExit);
      reject(error);
    };

    const killSafely = (signal: NodeJS.Signals) => {
      try {
        const signalSent = process.kill(signal);
        if (!signalSent) {
          // Child process already exited; treat as stopped.
          resolveOnce();
        }
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException | undefined;
        if (nodeError?.code === 'ESRCH') {
          // Process already exited between checks; treat as stopped.
          resolveOnce();
          return;
        }
        rejectOnce(
          new Error(
            `Failed to stop local anvil process with ${signal}: ${getErrorMessage(error)}`,
          ),
        );
      }
    };

    const timeout = setTimeout(() => {
      killSafely('SIGKILL');
      resolveOnce();
    }, LOCAL_ANVIL_STOP_TIMEOUT_MS);

    const onExit = () => resolveOnce();
    process.once('exit', onExit);

    killSafely('SIGTERM');
  });
}

async function startLocalAnvil(
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<StartedAnvil> {
  const port = await getAvailablePort();
  const process = spawn(
    'anvil',
    [
      '--host',
      LOCAL_ANVIL_HOST,
      '-p',
      port.toString(),
      '--chain-id',
      chainId.toString(),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise<StartedAnvil>((resolve, reject) => {
    let output = '';

    const cleanupListeners = () => {
      clearTimeout(startupTimeout);
      process.stdout.removeListener('data', onData);
      process.stderr.removeListener('data', onData);
      process.removeListener('error', onError);
      process.removeListener('exit', onExitBeforeReady);
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes('Listening on')) return;

      cleanupListeners();
      resolve({
        rpc: `http://${LOCAL_ANVIL_HOST}:${port}`,
        stop: () => stopLocalAnvilProcess(process),
      });
    };

    const onError = (error: Error) => {
      cleanupListeners();
      reject(new Error(formatLocalAnvilStartError(error)));
    };

    const onExitBeforeReady = (code: number | null, signal: string | null) => {
      cleanupListeners();
      reject(
        new Error(
          `Local anvil exited before startup (code=${code}, signal=${signal}). Output: ${output.trim()}`,
        ),
      );
    };

    const startupTimeout = setTimeout(() => {
      cleanupListeners();
      void stopLocalAnvilProcess(process).catch(() => undefined);
      reject(
        new Error(
          `Timed out waiting for local anvil startup after ${LOCAL_ANVIL_STARTUP_TIMEOUT_MS}ms`,
        ),
      );
    }, LOCAL_ANVIL_STARTUP_TIMEOUT_MS);

    process.stdout.on('data', onData);
    process.stderr.on('data', onData);
    process.once('error', onError);
    process.once('exit', onExitBeforeReady);
  });
}

async function startAnvil(
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<StartedAnvil> {
  try {
    const container = await startAnvilContainer(chainId);
    return {
      rpc: getAnvilRpcUrl(container),
      stop: () => container.stop(),
    };
  } catch (error) {
    if (!isContainerRuntimeUnavailable(error)) throw error;

    if (!hasLoggedLocalFallback) {
      console.warn(
        'Container runtime unavailable; falling back to local anvil process.',
      );
      hasLoggedLocalFallback = true;
    }

    return startLocalAnvil(chainId);
  }
}

/**
 * Setup function for Mocha tests that require Anvil RPC.
 * Starts a fresh Anvil runtime for EACH TEST to ensure complete isolation.
 *
 * Runtime strategy:
 * - Primary: testcontainers (`ghcr.io/foundry-rs/foundry`)
 * - Fallback: local `anvil` binary when container runtime is unavailable
 *
 * Guarantees:
 * - Dynamic port assignment (no port conflicts)
 * - Fresh chain state per test
 * - Graceful cleanup on both runtime strategies
 *
 * Usage:
 * ```typescript
 * describe('My Tests', function() {
 *   const anvil = setupAnvilTestSuite(this);
 *
 *   it('test case', async () => {
 *     const rpc = anvil.rpc; // http://localhost:<dynamic-port>
 *   });
 * });
 * ```
 */
export function setupAnvilTestSuite(
  suite: Mocha.Suite,
  chainId: number = DEFAULT_CHAIN_ID,
): { rpc: string } {
  // Use a getter pattern so rpc is always current after container starts
  const state: {
    anvil: StartedAnvil | null;
    rpc: string;
  } = {
    anvil: null,
    rpc: '', // Will be set after container starts
  };

  suite.timeout(180000); // 3 minutes per test

  // Start fresh anvil container before EACH test
  suite.beforeEach(async function () {
    // Stop any existing container
    if (state.anvil) {
      await state.anvil.stop();
      state.anvil = null;
    }

    state.anvil = await startAnvil(chainId);
    state.rpc = state.anvil.rpc;
  });

  // Stop container after EACH test for clean slate
  suite.afterEach(async function () {
    if (state.anvil) {
      await state.anvil.stop();
      state.anvil = null;
    }
  });

  return state;
}
