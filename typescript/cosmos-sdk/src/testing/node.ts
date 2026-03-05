import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

import { type TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { pollAsync, retryAsync } from '@hyperlane-xyz/utils';

type CometStatusResponse = {
  result?: {
    sync_info?: {
      latest_block_height?: string;
    };
  };
};

async function waitForCosmosRpcReady(rpcPort: number): Promise<void> {
  const statusUrl = `http://127.0.0.1:${rpcPort}/status`;

  await pollAsync(
    async () => {
      const response = await fetch(statusUrl);
      if (!response.ok) {
        throw new Error(
          `Cosmos RPC not ready at ${statusUrl}: HTTP ${response.status}`,
        );
      }

      const status = (await response.json()) as CometStatusResponse;
      const latestHeight = Number(
        status.result?.sync_info?.latest_block_height ?? '0',
      );
      if (!Number.isFinite(latestHeight) || latestHeight < 1) {
        throw new Error(
          `Cosmos RPC has no committed blocks yet at ${statusUrl}`,
        );
      }
    },
    1000,
    30,
  );
}

export async function runCosmosNode({
  rpcPort,
  restPort,
}: TestChainMetadata): Promise<StartedTestContainer> {
  // Retry container start to handle transient Docker registry 503 errors in CI
  const container = await retryAsync(
    () =>
      new GenericContainer(
        'ghcr.io/hyperlane-xyz/hyperlane-cosmos-simapp:v1.0.1',
      )
        .withExposedPorts(
          {
            // default port on the container
            container: 26657,
            host: rpcPort,
          },
          {
            // default port on the container
            container: 1317,
            host: restPort,
          },
        )
        .withWaitStrategy(
          Wait.forLogMessage(/received complete proposal block/),
        )
        .start(),
    3,
    5000,
  );

  // The container log indicates proposals are flowing, but RPC may still race.
  await waitForCosmosRpcReady(rpcPort);

  return container;
}
