import search from '@inquirer/search';

import { filterWarpRoutesIds } from '@hyperlane-xyz/registry';
import {
  WarpCoreConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import {
  assert,
  intersection,
  objFilter,
  setEquality,
} from '@hyperlane-xyz/utils';

import {
  readWarpCoreConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import { CommandContext, WriteCommandContext } from '../context/types.js';
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
    warpCoreConfig = await readWarpCoreConfig({ filePath: warp });
  } else {
    logRed(`Please specify either a symbol or warp config`);
    process.exit(0);
  }

  return warpCoreConfig;
}

/**
 * Gets or prompts user selection for a warp route ID.
 * Uses provided ID or filters by symbol and prompts if multiple options exist.
 */
export async function useProvidedWarpRouteIdOrPrompt({
  context,
  warpRouteId,
  symbol,
  promptByDeploymentConfigs,
}: {
  context: CommandContext;
  warpRouteId?: string;
  symbol?: string;
  promptByDeploymentConfigs?: boolean;
}): Promise<string> {
  if (warpRouteId) return warpRouteId;
  assert(!context.skipConfirmation, 'Warp route ID is required');

  const { ids: routeIds } = filterWarpRoutesIds(
    (await context.registry.listRegistryContent()).deployments[
      promptByDeploymentConfigs ? 'warpDeployConfig' : 'warpRoutes'
    ],
    symbol ? { symbol } : undefined,
  );

  assert(routeIds.length !== 0, 'No valid warp routes found in registry');

  return routeIds.length === 1
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

async function loadWarpConfigsFromFiles({
  warpDeployConfigPath,
  warpCoreConfigPath,
  context,
}: {
  warpDeployConfigPath: string;
  warpCoreConfigPath: string;
  context: CommandContext;
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
}> {
  const warpDeployConfig = await readWarpRouteDeployConfig({
    filePath: warpDeployConfigPath,
    context,
  });
  const warpCoreConfig = await readWarpCoreConfig({
    filePath: warpCoreConfigPath,
  });
  return { warpDeployConfig, warpCoreConfig };
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
  context: CommandContext | WriteCommandContext;
  warpRouteId?: string;
  warpDeployConfigPath?: string;
  warpCoreConfigPath?: string;
  symbol?: string;
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
}> {
  const hasDeployConfigFilePath = !!warpDeployConfigPath;
  const hasCoreConfigFilePath = !!warpCoreConfigPath;
  assert(
    hasDeployConfigFilePath === hasCoreConfigFilePath,
    'Both --config/-wd and --warp/-wc must be provided together when using individual file paths',
  );

  if (hasDeployConfigFilePath && hasCoreConfigFilePath) {
    return loadWarpConfigsFromFiles({
      warpDeployConfigPath,
      warpCoreConfigPath,
      context,
    });
  }

  const selectedId = await useProvidedWarpRouteIdOrPrompt({
    context,
    warpRouteId,
    symbol,
  });

  const warpCoreConfig = await readWarpCoreConfig({
    context,
    warpRouteId: selectedId,
  });
  const warpDeployConfig = await readWarpRouteDeployConfig({
    warpRouteId: selectedId,
    context,
  });

  return {
    warpDeployConfig,
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
