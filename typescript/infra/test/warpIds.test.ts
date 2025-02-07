import { expect } from 'chai';

import { getRegistry } from '@hyperlane-xyz/cli';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';

describe('Warp IDs', () => {
  it('Has all warp IDs in the registry', () => {
    const registry = getRegistry(DEFAULT_GITHUB_REGISTRY, '', true);
    for (const warpId of Object.values(WarpRouteIds)) {
      // That's a long sentence!
      expect(
        registry.getWarpRoute(warpId),
        `Warp ID ${warpId} not in registry, the .registryrc or your local registry may be out of date`,
      ).to.not.be.null.and.not.be.undefined;
    }
  });
});
