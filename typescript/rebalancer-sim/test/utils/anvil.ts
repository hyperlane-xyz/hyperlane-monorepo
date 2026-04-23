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
 * Starts a fresh Anvil container for EACH TEST to ensure complete isolation.
 * Timeouts are set globally via vitest.config.ts testTimeout/hookTimeout.
 *
 * Usage:
 * ```typescript
 * describe('My Tests', () => {
 *   const anvil = setupAnvilTestSuite();
 *
 *   it('test case', async () => {
 *     const rpc = anvil.rpc; // http://localhost:<dynamic-port>
 *   });
 * });
 * ```
 */
export function setupAnvilTestSuite(chainId: number = DEFAULT_CHAIN_ID): {
  rpc: string;
} {
  const state: {
    container: StartedTestContainer | null;
    rpc: string;
  } = {
    container: null,
    rpc: '',
  };

  beforeEach(async () => {
    if (state.container) {
      await state.container.stop();
      state.container = null;
    }

    state.container = await startAnvilContainer(chainId);
    state.rpc = getAnvilRpcUrl(state.container);
  });

  afterEach(async () => {
    if (state.container) {
      await state.container.stop();
      state.container = null;
    }
  });

  return state;
}
