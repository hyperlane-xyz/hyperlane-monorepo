import { JsonRpcProvider, Wallet } from 'ethers';

import { MultiProvider, revertToSnapshot, snapshot } from '@hyperlane-xyz/sdk';
import { assert, retryAsync } from '@hyperlane-xyz/utils';

import { ANVIL_TEST_PRIVATE_KEY } from '../fixtures/routes.js';

const SNAPSHOT_RPC_TIMEOUT_MS = 10_000;

type SnapshotResetOptions = {
  localProviders: Map<string, JsonRpcProvider>;
  multiProvider: MultiProvider;
  snapshotIds: Map<string, string>;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createFreshProvider(
  multiProvider: MultiProvider,
  chain: string,
): JsonRpcProvider {
  const chainMetadata = multiProvider.getChainMetadata(chain);
  const rpcUrl = chainMetadata.rpcUrls[0]?.http;
  assert(rpcUrl, `Missing rpc url for chain ${chain}`);
  return new JsonRpcProvider(rpcUrl);
}

async function revertAndSnapshotWithRetries(
  provider: JsonRpcProvider,
  snapshotId: string,
): Promise<string> {
  return retryAsync(
    async () => {
      const reverted = await withTimeout(
        revertToSnapshot(provider, snapshotId),
        SNAPSHOT_RPC_TIMEOUT_MS,
      );
      assert(reverted, `evm_revert returned false for snapshot ${snapshotId}`);
      return withTimeout(snapshot(provider), SNAPSHOT_RPC_TIMEOUT_MS);
    },
    2,
    250,
  );
}

export async function resetSnapshotsAndRefreshProviders({
  localProviders,
  multiProvider,
  snapshotIds,
}: SnapshotResetOptions): Promise<void> {
  const chains = Array.from(localProviders.keys());

  for (const chain of chains) {
    const existingProvider = localProviders.get(chain);
    assert(existingProvider, `Missing provider for chain ${chain}`);
    const snapshotId = snapshotIds.get(chain);
    assert(snapshotId, `Missing snapshot id for chain ${chain}`);

    try {
      const newSnapshotId = await revertAndSnapshotWithRetries(
        existingProvider,
        snapshotId,
      );
      snapshotIds.set(chain, newSnapshotId);
    } catch (_error) {
      const freshProvider = createFreshProvider(multiProvider, chain);
      const newSnapshotId = await revertAndSnapshotWithRetries(
        freshProvider,
        snapshotId,
      );
      snapshotIds.set(chain, newSnapshotId);
      localProviders.set(chain, freshProvider);
    }
  }

  // Refresh provider/signer bindings after evm_revert to avoid stale provider state.
  const signerWallet = new Wallet(ANVIL_TEST_PRIVATE_KEY);
  for (const chain of chains) {
    const freshProvider = createFreshProvider(multiProvider, chain);
    localProviders.set(chain, freshProvider);
    multiProvider.setProvider(chain, freshProvider);
    multiProvider.setSigner(chain, signerWallet.connect(freshProvider));
  }
}
