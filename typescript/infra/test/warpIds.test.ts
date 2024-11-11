import { expect } from 'chai';

import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import { getRegistry } from '../config/registry.js';

describe('Warp IDs', () => {
  it('Has all warp IDs in the registry', () => {
    const registry = getRegistry();
    for (const warpId of Object.values(WarpRouteIds)) {
      // That's a long sentence!
      expect(registry.getWarpRoute(warpId), `Warp ID ${warpId} not in registry`)
        .to.not.be.null.and.not.be.undefined;
    }
  });
});
