import {
  GenericContainer,
  StartedTestContainer,
} from 'testcontainers';

import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, retryAsync, sleep } from '@hyperlane-xyz/utils';

import {
  STARKNET_DEVNET_IMAGE,
  STARKNET_DEVNET_TAG,
  TEST_STARKNET_CHAIN_METADATA,
} from './constants.js';

const RPC_READY_MAX_ATTEMPTS = 20;
const RPC_READY_RETRY_MS = 1000;

async function waitForRpcReady(rpcUrl: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RPC_READY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'starknet_blockNumber',
          params: [],
        }),
      });

      if (!response.ok) {
        throw new Error(`rpc not ready: ${response.status}`);
      }

      const payload = await response.json();
      if (
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        payload.error
      ) {
        throw new Error(`rpc returned error: ${JSON.stringify(payload.error)}`);
      }
      await sleep(1000);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RPC_READY_MAX_ATTEMPTS) {
        await sleep(RPC_READY_RETRY_MS);
      }
    }
  }

  throw new Error(
    `starknet rpc did not become ready after ${RPC_READY_MAX_ATTEMPTS} attempts: ${String(
      lastError,
    )}`,
  );
}

export async function runStarknetNode(
  chainMetadata: TestChainMetadata = TEST_STARKNET_CHAIN_METADATA,
): Promise<StartedTestContainer> {
  const rpcUrl = chainMetadata.rpcUrls?.[0]?.http;
  assert(rpcUrl, 'Expected Starknet rpc url to be defined for e2e tests');

  return retryAsync(async () => {
    let container: StartedTestContainer | undefined;
    try {
      container = await new GenericContainer(
        `${STARKNET_DEVNET_IMAGE}:${STARKNET_DEVNET_TAG}`,
      )
        .withExposedPorts({
          container: 5050,
          host: chainMetadata.rpcPort,
        })
        .withCommand([
          '--state-archive-capacity',
          'full',
          '--block-generation-on',
          '5',
          '--seed',
          '0',
        ])
        .start();

      await waitForRpcReady(rpcUrl);
      return container;
    } catch (error) {
      if (container) {
        await container.stop().catch(() => undefined);
      }
      throw error;
    }
  }, 3, 5000);
}
