import { ethers, providers } from 'ethers';

import { MultiProvider, revertToSnapshot, snapshot } from '@hyperlane-xyz/sdk';
import { assert, retryAsync } from '@hyperlane-xyz/utils';

import { ANVIL_TEST_PRIVATE_KEY, TEST_CHAINS } from '../fixtures/routes.js';

function createFreshProvider(url: string): providers.JsonRpcProvider {
  return new providers.JsonRpcProvider(url);
}

/**
 * Revert all chains to their snapshots, take new snapshots, and refresh
 * the providers in both localProviders and multiProvider so that ethers v5
 * internal block-number caches are cleared.
 */
export async function resetSnapshotsAndRefreshProviders({
  localProviders,
  multiProvider,
  snapshotIds,
}: {
  localProviders: Map<string, providers.JsonRpcProvider>;
  multiProvider: MultiProvider;
  snapshotIds: Map<string, string>;
}): Promise<void> {
  for (const [chain, provider] of localProviders) {
    const id = snapshotIds.get(chain);
    assert(id, `Missing snapshot id for chain ${chain}`);
    await revertToSnapshot(provider, id);
    snapshotIds.set(chain, await snapshot(provider));
  }

  // Replace providers so ethers v5 internal block-number caches are cleared.
  const signerWallet = new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY);

  for (const [chain, oldProvider] of Array.from(localProviders.entries())) {
    const url = oldProvider.connection.url;
    const freshProvider = createFreshProvider(url);
    localProviders.set(chain, freshProvider);
    multiProvider.setProvider(chain, freshProvider);
    multiProvider.setSigner(chain, signerWallet.connect(freshProvider));
  }

  // Wait until every fresh provider can serve a basic RPC call.
  await Promise.all(
    TEST_CHAINS.map((chain) => {
      const p = localProviders.get(chain);
      assert(p, `Missing provider for chain ${chain}`);
      return retryAsync(() => p.send('eth_blockNumber', []), 10, 500);
    }),
  );
}
