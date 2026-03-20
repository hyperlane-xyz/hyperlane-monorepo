import { expect } from 'chai';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';

describe('Warp IDs', function () {
  this.timeout(60_000); // 60s timeout for fetching all warp IDs from registry

  it('Has all warp IDs in the registry', async () => {
    const registry = getRegistry({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      enableProxy: true,
      logger: rootLogger,
    });
    for (const warpId of Object.values(WarpRouteIds)) {
      // Retry to handle transient network failures (e.g. socket closed)
      // when fetching from GitHub registry in CI
      const route = await retryAsync(
        () => registry.getWarpRoute(warpId),
        3,
        500,
      );
      expect(
        route,
        `Warp ID ${warpId} not in registry, the .registryrc or your local registry may be out of date`,
      ).to.not.be.null.and.not.be.undefined;
    }
  });
});
