import search from '@inquirer/search';

import { filterWarpRoutesIds } from '@hyperlane-xyz/registry';
import {
  type WarpCoreConfig,
  type WarpRouteDeployConfigMailboxRequired,
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
}: {
  context: CommandContext;
  warpRouteId?: string;
}): Promise<WarpCoreConfig> {
  const resolvedWarpRouteId = await resolveWarpRouteId({
    context,
    warpRouteId,
  });
  const config = await context.registry.getWarpRoute(resolvedWarpRouteId);
  assert(config, `No warp route found with ID "${resolvedWarpRouteId}"`);
  return config;
}

export async function resolveWarpRouteId({
  context,
  warpRouteId,
  promptByDeploymentConfigs,
}: {
  context: CommandContext;
  warpRouteId?: string;
  promptByDeploymentConfigs?: boolean;
}): Promise<string> {
  if (warpRouteId) {
    return warpRouteId;
  }

  assert(!context.skipConfirmation, 'Warp route ID is required (use -w)');

  const { ids: routeIds } = filterWarpRoutesIds(
    (await context.registry.listRegistryContent()).deployments[
      promptByDeploymentConfigs ? 'warpDeployConfig' : 'warpRoutes'
    ],
  );

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
}: {
  context: CommandContext | WriteCommandContext;
  warpRouteId?: string;
}): Promise<{
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  warpCoreConfig: WarpCoreConfig;
}> {
  const resolvedWarpRouteId = await resolveWarpRouteId({
    context,
    warpRouteId,
  });

  const warpCoreConfig = await readWarpCoreConfig({
    context,
    warpRouteId: resolvedWarpRouteId,
  });
  const warpDeployConfig = await readWarpRouteDeployConfig({
    warpRouteId: resolvedWarpRouteId,
    context,
  });

  return { warpDeployConfig, warpCoreConfig };
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
