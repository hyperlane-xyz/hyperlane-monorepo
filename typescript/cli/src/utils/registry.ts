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
 * Get warp deploy config for a warp route from the registry
 */
export async function getWarpDeployConfig(
  routeId: string,
  context: CommandContext,
): Promise<WarpRouteDeployConfig | null> {
  const { registry } = context;
  const warpDeployConfig = await registry.getWarpDeployConfig(routeId);
  assert(
    warpDeployConfig,
    `Missing warp deploy config for warp route ${routeId}.`,
  );
  return warpDeployConfig;
}

/**
 * Get warp core config for a warp route from the registry
 */
export async function getWarpCoreConfig(
  routeId: string,
  context: CommandContext,
): Promise<WarpCoreConfig> {
  const { registry } = context;
  const routes = await registry.getWarpRoutes();
  const warpCoreConfig = routes[routeId];
  assert(warpCoreConfig, `Missing warp config for warp route ${routeId}.`);
  return warpCoreConfig;
}

/**
 * Get both warp core and warp deploy configs for a warp route from the registry
 */
export async function getWarpConfigFromRegistry(
  routeId: string,
  context: CommandContext,
): Promise<{
  warpDeployConfig: WarpRouteDeployConfig | null;
  warpCoreConfig: WarpCoreConfig;
}> {
  return {
    warpDeployConfig: await getWarpDeployConfig(routeId, context),
    warpCoreConfig: await getWarpCoreConfig(routeId, context),
  };
}
