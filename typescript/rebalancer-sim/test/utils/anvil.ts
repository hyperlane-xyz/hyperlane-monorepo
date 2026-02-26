import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { retryAsync } from '@hyperlane-xyz/utils';

const CONTAINER_PORT = 8545; // Port inside the container (fixed)
const DEFAULT_CHAIN_ID = 31337;

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

/**
 * Setup function for Mocha tests that require Anvil.
 * Starts a fresh Anvil container for EACH TEST to ensure complete isolation.
 *
 * Uses testcontainers for:
 * - No local anvil installation required
 * - Automatic container cleanup (even on crashes)
 * - Dynamic port assignment (no port conflicts)
 * - Retry logic for CI reliability
 * - Consistent behavior across local/CI environments
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
    container: StartedTestContainer | null;
    rpc: string;
  } = {
    container: null,
    rpc: '', // Will be set after container starts
  };

  suite.timeout(180000); // 3 minutes per test

  // Start fresh anvil container before EACH test
  suite.beforeEach(async function () {
    // Stop any existing container
    if (state.container) {
      await state.container.stop();
      state.container = null;
    }

    state.container = await startAnvilContainer(chainId);
    state.rpc = getAnvilRpcUrl(state.container);
  });

  // Stop container after EACH test for clean slate
  suite.afterEach(async function () {
    if (state.container) {
      await state.container.stop();
      state.container = null;
    }
  });

  return state;
}
