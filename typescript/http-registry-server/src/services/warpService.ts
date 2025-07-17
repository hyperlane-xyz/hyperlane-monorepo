import { WarpRouteId } from '@hyperlane-xyz/registry';
import { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { NotFoundError } from '../errors/ApiError.js';

import { AbstractService } from './abstractService.js';
import { RegistryService } from './registryService.js';

export class WarpService extends AbstractService {
  constructor(registryService: RegistryService) {
    super(registryService);
  }

  async getWarpRoute(id: WarpRouteId): Promise<WarpCoreConfig> {
    return this.withRegistry(async (registry) => {
      const warpRoute = await registry.getWarpRoute(id);
      if (!warpRoute) {
        throw new NotFoundError(`Warp route not found for id ${id}`);
      }
      return warpRoute;
    });
  }
}
