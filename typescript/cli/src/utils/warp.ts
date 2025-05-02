import search from '@inquirer/search';

import { filterWarpRoutesIds } from '@hyperlane-xyz/registry';
import {
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigMailboxRequiredSchema,
} from '@hyperlane-xyz/sdk';
import {
  assert,
  intersection,
  objFilter,
  setEquality,
} from '@hyperlane-xyz/utils';

import {
  fillDefaults,
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
 * - warpDeployConfigPath & warpCoreConfigPath: reads from files
 * - symbol: prompts user to select from matching routes
 * - no inputs: prompts user to search and select from all routes
 */
export async function getWarpConfigs({
  context,
  warpRouteId,
  warpDeployConfigPath,
  warpCoreConfigPath,
  symbol,
}: {
  context: CommandContext;
  warpRouteId?: string;
  warpDeployConfigPath?: string;
  warpCoreConfigPath?: string;
  symbol?: string;
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
}> {
  if (warpDeployConfigPath || warpCoreConfigPath) {
    if (!warpDeployConfigPath || !warpCoreConfigPath) {
      throw new Error(
        'Both --config/-wd and --warp/-wc must be provided together when using individual file paths',
      );
    }
    const warpDeployConfig = await readWarpRouteDeployConfig(
      warpDeployConfigPath,
      context,
    );
    const warpCoreConfig = readWarpCoreConfig(warpCoreConfigPath);
    return { warpDeployConfig, warpCoreConfig };
  }

  let selectedId = warpRouteId;
  if (!selectedId) {
    const { ids: routeIds } = filterWarpRoutesIds(
      (await context.registry.listRegistryContent()).deployments.warpRoutes,
      symbol ? { symbol } : undefined,
    );

    assert(routeIds.length !== 0, 'No valid warp routes found in registry');

    selectedId =
      routeIds.length === 1
        ? routeIds[0]
        : ((await search({
            message: 'Select a warp route:',
            source: (term) => {
              return routeIds.filter((id) =>
                id.toLowerCase().includes(term?.toLowerCase() || ''),
              );
            },
            pageSize: 20,
          })) as string);
  }

  const warpCoreConfig = await context.registry.getWarpRoute(selectedId);
  assert(warpCoreConfig, `Missing warp config for warp route ${selectedId}.`);
  const warpDeployConfig =
    await context.registry.getWarpDeployConfig(selectedId);
  assert(
    warpDeployConfig,
    `Missing warp deploy config for warp route ${selectedId}.`,
  );

  const filledConfig = await fillDefaults(context, warpDeployConfig);
  const validatedConfig =
    WarpRouteDeployConfigMailboxRequiredSchema.parse(filledConfig);

  return {
    warpDeployConfig: validatedConfig,
    warpCoreConfig,
  };
}

/**
 * Compares chains between warp deploy and core configs, filters them to only include matching chains,
 * and logs warnings if there are mismatches.
 * @param warpDeployConfig The warp deployment configuration
 * @param warpCoreConfig The warp core configuration
 * @returns The filtered warp deploy and core configs containing only matching chains
 */
export function filterWarpConfigsToMatchingChains(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  warpCoreConfig: WarpCoreConfig,
): {
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
} {
  const deployConfigChains = Object.keys(warpDeployConfig);
  const coreConfigChains = warpCoreConfig.tokens.map(
    (t: { chainName: string }) => t.chainName,
  );

  const deploySet = new Set(deployConfigChains);
  const coreSet = new Set(coreConfigChains);

  if (!setEquality(deploySet, coreSet)) {
    logRed(
      'Warning: Chain mismatch between warp core config and warp deploy config:',
    );
    logRed('──────────────────────');
    logRed('Deploy config chains:');
    deployConfigChains.forEach((chain: string) => logRed(`  - ${chain}`));
    logRed('Core config chains:');
    coreConfigChains.forEach((chain: string) => logRed(`  - ${chain}`));

    const matchingChains = intersection(deploySet, coreSet);
    if (matchingChains.size === 0) {
      logRed('Error: No matching chains found between configs');
      process.exit(1);
    }

    logRed(
      `Continuing with check for matching chains: ${Array.from(
        matchingChains,
      ).join(', ')}\n`,
    );

    // Filter configs to only include matching chains
    const filteredWarpDeployConfig = objFilter(
      warpDeployConfig,
      (chain: string, _v): _v is any => matchingChains.has(chain),
    );
    const filteredWarpCoreConfig = {
      ...warpCoreConfig,
      tokens: warpCoreConfig.tokens.filter((token: { chainName: string }) =>
        matchingChains.has(token.chainName),
      ),
    };

    return {
      warpDeployConfig: filteredWarpDeployConfig,
      warpCoreConfig: filteredWarpCoreConfig,
    };
  }

  return { warpDeployConfig, warpCoreConfig };
}
