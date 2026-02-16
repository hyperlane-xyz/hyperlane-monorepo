import search from '@inquirer/search';

import { filterWarpRoutesIds } from '@hyperlane-xyz/registry';
import {
  type WarpCoreConfig,
  type WarpRouteDeployConfigMailboxRequired,
  filterWarpCoreConfigMapByChains,
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
import {
  type CommandContext,
  type WriteCommandContext,
} from '../context/types.js';
import { logRed } from '../logger.js';

export async function getWarpCoreConfigOrExit({
  context,
  warpRouteId,
  chains,
}: {
  context: CommandContext;
  warpRouteId?: string;
  chains?: string[];
}): Promise<WarpCoreConfig> {
  const resolvedWarpRouteId = await resolveWarpRouteId({
    context,
    warpRouteId,
    chains,
  });
  const config = await context.registry.getWarpRoute(resolvedWarpRouteId);
  assert(config, `No warp route found with ID "${resolvedWarpRouteId}"`);
  return config;
}

export async function resolveWarpRouteId({
  context,
  warpRouteId,
  promptByDeploymentConfigs,
  chains,
}: {
  context: CommandContext;
  warpRouteId?: string;
  promptByDeploymentConfigs?: boolean;
  /** Filter routes to only those spanning all specified chains */
  chains?: string[];
}): Promise<string> {
  const deployments = (await context.registry.listRegistryContent())
    .deployments;
  const source = promptByDeploymentConfigs
    ? deployments.warpDeployConfig
    : deployments.warpRoutes;

  if (warpRouteId) {
    if (warpRouteId.includes('/')) {
      return warpRouteId;
    }

    const symbol = warpRouteId.toUpperCase();
    let matchingIds: string[];

    // When chains are specified, load full configs and filter by chains
    if (chains && chains.length > 0) {
      const warpConfigs = await context.registry.getWarpRoutes({ symbol });
      const filtered = filterWarpCoreConfigMapByChains(warpConfigs, chains);
      matchingIds = Object.keys(filtered);
    } else {
      const { ids } = filterWarpRoutesIds(source, { symbol });
      matchingIds = ids;
    }

    if (matchingIds.length === 0) {
      if (chains && chains.length > 0) {
        throw new Error(
          `No warp route found for symbol "${symbol}" spanning chains: ${chains.join(', ')}. ` +
            `Try without --chains to see all available routes for this symbol.`,
        );
      }
      return warpRouteId;
    }

    if (matchingIds.length === 1) {
      return matchingIds[0];
    }

    if (context.skipConfirmation) {
      throw new Error(
        `Multiple warp routes found for symbol "${symbol}". ` +
          `Specify full route ID:\n${matchingIds.map((id) => `  - ${id}`).join('\n')}`,
      );
    }

    return (await search({
      message: `Multiple routes found for "${symbol}". Select one:`,
      source: (term) =>
        matchingIds.filter((id) =>
          id.toLowerCase().includes(term?.toLowerCase() || ''),
        ),
      pageSize: 20,
    })) as string;
  }

  assert(!context.skipConfirmation, 'Warp route ID is required (use -w)');

  let routeIds: string[];

  if (chains && chains.length > 0) {
    const warpConfigs = await context.registry.getWarpRoutes();
    const filtered = filterWarpCoreConfigMapByChains(warpConfigs, chains);
    routeIds = Object.keys(filtered);
  } else {
    const result = filterWarpRoutesIds(source);
    routeIds = result.ids;
  }

  assert(routeIds.length !== 0, 'No warp routes found in registry');

  if (routeIds.length === 1) {
    return routeIds[0];
  }

  return (await search({
    message: 'Select a warp route:',
    source: (term) =>
      routeIds.filter((id) =>
        id.toLowerCase().includes(term?.toLowerCase() || ''),
      ),
    pageSize: 20,
  })) as string;
}

export async function getWarpConfigs({
  context,
  warpRouteId,
  chains,
}: {
  context: CommandContext | WriteCommandContext;
  warpRouteId?: string;
  chains?: string[];
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
  resolvedWarpRouteId: string;
}> {
  const resolvedWarpRouteId = await resolveWarpRouteId({
    context,
    warpRouteId,
    chains,
  });

  const warpCoreConfig = await readWarpCoreConfig({
    context,
    warpRouteId: resolvedWarpRouteId,
  });
  const warpDeployConfig = await readWarpRouteDeployConfig({
    warpRouteId: resolvedWarpRouteId,
    context,
  });

  return { warpDeployConfig, warpCoreConfig, resolvedWarpRouteId };
}

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
