import search from '@inquirer/search';

import { warpRouteConfigToId } from '@hyperlane-xyz/registry';
import { WarpCoreConfig, WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  readWarpCoreConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import { CommandContext } from '../context/types.js';
import { logRed } from '../logger.js';

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
  if (config || warp) {
    if (!config || !warp) {
      throw new Error(
        'Both --config/-i and --warp/-wc must be provided together when using individual file paths',
      );
    }
    const warpDeployConfig = await readWarpRouteDeployConfig(config, context);
    const warpCoreConfig = readWarpCoreConfig(warp);
    return { warpDeployConfig, warpCoreConfig };
  }

  if (symbol && !warpRouteId) {
    const warpCoreConfig = await selectRegistryWarpRoute(
      context.registry,
      symbol,
    );
    const routeId = warpRouteConfigToId(warpCoreConfig);
    assert(routeId, `No matching warp route ID found for symbol ${symbol}`);

    const warpDeployConfig = await context.registry.getWarpDeployConfig(
      routeId,
    );

    assert(
      warpDeployConfig,
      `warp deploy config not found for route ${routeId}`,
    );

    return { warpDeployConfig, warpCoreConfig };
  }

  let selectedId = warpRouteId;

  // No inputs provided, prompt user to select from all routes
  if (!selectedId) {
    const routeIds = Object.keys(
      (await context.registry.listRegistryContent()).deployments.warpRoutes,
    );
    if (routeIds.length === 0) {
      throw new Error('No valid warp routes found in registry');
    }

    selectedId = (await search({
      message: 'Select a warp route:',
      source: (term) => {
        return routeIds.filter((id) =>
          id.toLowerCase().includes(term?.toLowerCase() || ''),
        );
      },
      pageSize: 20,
    })) as string;
  }

  const warpCoreConfig = await context.registry.getWarpRoute(selectedId);
  assert(warpCoreConfig, `Missing warp config for warp route ${selectedId}.`);
  const warpDeployConfig = await context.registry.getWarpDeployConfig(
    selectedId,
  );
  assert(
    warpDeployConfig,
    `Missing warp deploy config for warp route ${selectedId}.`,
  );

  return {
    warpDeployConfig,
    warpCoreConfig,
  };
}
