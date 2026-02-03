import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { retryAsync } from '@hyperlane-xyz/utils';

const DEFAULT_ANVIL_PORT = 8545;
const DEFAULT_CHAIN_ID = 31337;

/**
 * Start an Anvil container using testcontainers.
 * Uses the same pattern as CLI e2e tests for consistency.
 */
export async function startAnvilContainer(
  port: number = DEFAULT_ANVIL_PORT,
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
          port.toString(),
          '--chain-id',
          chainId.toString(),
        ])
        .withExposedPorts({
          container: port,
          host: port,
        })
        .withWaitStrategy(Wait.forLogMessage(/Listening on/))
        .start(),
    3, // maxRetries
    5000, // baseRetryMs
  );
}

/**
 * Setup function for Mocha tests that require Anvil.
 * Starts a fresh Anvil container for EACH TEST to ensure complete isolation.
 *
 * Uses testcontainers for:
 * - No local anvil installation required
 * - Automatic container cleanup (even on crashes)
 * - Retry logic for CI reliability
 * - Consistent behavior across local/CI environments
 *
 * Usage:
 * ```typescript
 * describe('My Tests', function() {
 *   const anvil = setupAnvilTestSuite(this, 8545);
 *
 *   it('test case', async () => {
 *     const rpc = anvil.rpc; // http://127.0.0.1:8545
 *   });
 * });
 * ```
 */
export function setupAnvilTestSuite(
  suite: Mocha.Suite,
  port: number = DEFAULT_ANVIL_PORT,
  chainId: number = DEFAULT_CHAIN_ID,
): { rpc: string } {
  const state: { rpc: string; container: StartedTestContainer | null } = {
    rpc: `http://127.0.0.1:${port}`,
    container: null,
  };

  suite.timeout(180000); // 3 minutes per test

  // Start fresh anvil container before EACH test
  suite.beforeEach(async function () {
    // Stop any existing container
    if (state.container) {
      await state.container.stop();
      state.container = null;
    }

    state.container = await startAnvilContainer(port, chainId);
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
