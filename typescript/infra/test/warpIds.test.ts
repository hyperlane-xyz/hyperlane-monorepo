import { expect } from 'chai';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';

describe('Warp IDs', () => {
  it('Has all warp IDs in the registry', async () => {
    const registry = getRegistry({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      enableProxy: true,
      logger: rootLogger,
    });
    for (const warpId of Object.values(WarpRouteIds)) {
      // That's a long sentence!
      expect(
        await registry.getWarpRoute(warpId),
        `Warp ID ${warpId} not in registry, the .registryrc or your local registry may be out of date`,
      ).to.not.be.null.and.not.be.undefined;
    }
  });
});
