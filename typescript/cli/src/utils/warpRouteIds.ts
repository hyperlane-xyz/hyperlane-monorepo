import search from '@inquirer/search';

import { filterWarpRoutesIds } from '@hyperlane-xyz/registry';
import { assert } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';

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
