import {
  AddWarpRouteConfigOptions,
  IRegistry,
  WarpDeployConfigMap,
  WarpRouteFilterParams,
  WarpRouteId,
} from '@hyperlane-xyz/registry';
import { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { NotFoundError } from '../errors/ApiError.js';

import { AbstractService } from './abstractService.js';
import { RegistryService } from './registryService.js';

export class WarpService extends AbstractService {
  constructor(registryService: RegistryService) {
    super(registryService);
  }

  async getWarpCoreConfig(id: WarpRouteId): Promise<WarpCoreConfig> {
    return this.withRegistry(async (registry) => {
      const warpRoute = await registry.getWarpRoute(id);
      if (!warpRoute) {
        throw new NotFoundError(`Warp route not found for id ${id}`);
      }
      return warpRoute;
    });
  }

  async getWarpCoreConfigs(
    filter?: WarpRouteFilterParams,
  ): Promise<ReturnType<IRegistry['getWarpRoutes']>> {
    return this.withRegistry(async (registry) => {
      return registry.getWarpRoutes(filter);
    });
  }

  async getWarpDeployConfig(id: WarpRouteId): Promise<WarpRouteDeployConfig> {
    return this.withRegistry(async (registry) => {
      const warpDeployConfig = await registry.getWarpDeployConfig(id);
      if (!warpDeployConfig) {
        throw new NotFoundError(`Warp deploy config not found for id ${id}`);
      }
      return warpDeployConfig;
    });
  }

  async getWarpDeployConfigs(
    filter?: WarpRouteFilterParams,
  ): Promise<WarpDeployConfigMap> {
    return this.withRegistry(async (registry) => {
      return registry.getWarpDeployConfigs(filter);
    });
  }

  async addWarpRoute(
    config: WarpCoreConfig,
    options?: AddWarpRouteConfigOptions,
  ): Promise<void> {
    return this.withRegistry(async (registry) => {
      await registry.addWarpRoute(config, options);
    });
  }

  async addWarpRouteConfig(
    config: WarpRouteDeployConfig,
    options: AddWarpRouteConfigOptions,
  ): Promise<void> {
    return this.withRegistry(async (registry) => {
      await registry.addWarpRouteConfig(config, options);
    });
  }
}
