import type { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type { CommandContext } from '../context/types.js';

/**
 * Get all available warp route IDs from the registry
 */
export async function getWarpRouteIds(
  context: CommandContext,
): Promise<string[]> {
  const { registry } = context;
  const routes = await registry.getWarpRoutes();
  return Object.keys(routes).filter((id) => routes[id] !== null);
}

/**
 * Get both deploy and core configs for a warp route from the registry
 */
export async function getWarpConfigFromRegistry(
  routeId: string,
  context: CommandContext,
): Promise<{
  deployConfig: WarpRouteDeployConfig;
  coreConfig: WarpCoreConfig;
}> {
  const { registry } = context;

  // Get deploy config first
  const deployConfig = await registry.getWarpDeployConfig(routeId);
  assert(deployConfig, `No deploy config found for warp route ${routeId}`);

  // Get core config from warp routes map
  const routes = await registry.getWarpRoutes();
  const coreConfig = routes[routeId];
  assert(coreConfig, `No core config found for warp route ${routeId}.`);

  return {
    deployConfig,
    coreConfig,
  };
}
