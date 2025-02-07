import search from '@inquirer/search';

import { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readWarpCoreConfig } from '../config/warp.js';
import { readWarpRouteDeployConfig } from '../config/warp.js';
import { CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';
import {
  getWarpConfigFromRegistry,
  getWarpRouteIds,
} from '../warp/registry.js';

import { selectRegistryWarpRoute } from './tokens.js';

/**
 * Gets a {@link WarpCoreConfig} based on the provided path or prompts the user to choose one:
 * - if `symbol` is provided the user will have to select one of the available warp routes.
 * - if `warp` is provided the config will be read by the provided file path.
 * - if none is provided the CLI will exit.
 */
export async function getWarpCoreConfigOrExit({
  context,
  symbol,
  warp,
}: {
  context: CommandContext;
  symbol?: string;
  warp?: string;
}): Promise<WarpCoreConfig> {
  let warpCoreConfig: WarpCoreConfig;
  if (symbol) {
    warpCoreConfig = await selectRegistryWarpRoute(context.registry, symbol);
  } else if (warp) {
    warpCoreConfig = readWarpCoreConfig(warp);
  } else {
    logRed(`Please specify either a symbol or warp config`);
    process.exit(0);
  }

  return warpCoreConfig;
}

/**
 * Gets both warp configs based on the provided inputs. Handles all cases:
 * - warpRouteId: gets configs directly from registry
 * - config & warp files: reads from files
 * - symbol: prompts user to select from matching routes
 * - no inputs: prompts user to search and select from all routes
 */
export async function getWarpConfigs({
  context,
  warpRouteId,
  config,
  warp,
  symbol,
}: {
  context: CommandContext;
  warpRouteId?: string;
  config?: string;
  warp?: string;
  symbol?: string;
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
}> {
  if (warpRouteId) {
    try {
      const configs = await getWarpConfigFromRegistry(warpRouteId, context);
      return {
        warpDeployConfig: configs.deployConfig as WarpRouteDeployConfig,
        warpCoreConfig: configs.coreConfig,
      };
    } catch (error: any) {
      throw new Error(
        `Failed to get configs for warp route ${warpRouteId}: ${error.message}`,
      );
    }
  }

  if (config && warp) {
    const warpDeployConfig = await readWarpRouteDeployConfig(config);
    const warpCoreConfig = readWarpCoreConfig(warp);
    return { warpDeployConfig, warpCoreConfig };
  }

  if (symbol) {
    const warpCoreConfig = await selectRegistryWarpRoute(
      context.registry,
      symbol,
    );
    try {
      const routeIds = await getWarpRouteIds(context);
      const matchingId = routeIds.find((id) =>
        id.toUpperCase().includes(symbol.toUpperCase()),
      );
      if (!matchingId) {
        throw new Error(`No matching warp route ID found for symbol ${symbol}`);
      }
      const configs = await getWarpConfigFromRegistry(matchingId, context);
      return {
        warpDeployConfig: configs.deployConfig as WarpRouteDeployConfig,
        warpCoreConfig,
      };
    } catch (error: any) {
      throw new Error(
        `Failed to get deploy config for symbol ${symbol}: ${error.message}`,
      );
    }
  }

  const routeIds = await getWarpRouteIds(context);
  if (routeIds.length === 0) {
    throw new Error('No valid warp routes found in registry');
  }

  const selectedId = (await search({
    message: 'Select a warp route:',
    source: (term) => {
      return routeIds.filter((id) =>
        id.toLowerCase().includes(term?.toLowerCase() || ''),
      );
    },
    pageSize: 20,
  })) as string;

  try {
    const configs = await getWarpConfigFromRegistry(selectedId, context);
    return {
      warpDeployConfig: configs.deployConfig as WarpRouteDeployConfig,
      warpCoreConfig: configs.coreConfig,
    };
  } catch (error: any) {
    throw new Error(
      `Failed to get configs for selected warp route ${selectedId}: ${error.message}`,
    );
  }
}
