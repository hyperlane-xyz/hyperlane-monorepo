import select from '@inquirer/select';

import { IRegistry } from '@hyperlane-xyz/registry';
import { Token, WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { logGreen, logRed } from '../logger.js';

export async function runTokenSelectionStep(
  tokens: Token[],
  message = 'Select token',
) {
  const choices = tokens.map((t) => ({
    name: `${t.symbol} - ${t.addressOrDenom}`,
    value: t.addressOrDenom,
  }));
  const routerAddress = (await select({
    message,
    choices,
    pageSize: 20,
  })) as string;
  return routerAddress;
}

export async function selectRegistryWarpRoute(
  registry: IRegistry,
  symbol: string,
): Promise<[string, WarpCoreConfig]> {
  const matching = await registry.getWarpRoutes({
    symbol,
  });
  const routes = Object.entries(matching);

  let warpCoreConfig: WarpCoreConfig;
  let warpId: string;
  if (routes.length === 0) {
    logRed(`No warp routes found for symbol ${symbol}`);
    process.exit(0);
  } else if (routes.length === 1) {
    warpCoreConfig = routes[0][1];
    warpId = routes[0][0];
  } else {
    logGreen(`Multiple warp routes found for symbol ${symbol}`);
    const chosenRouteId = await select({
      message: 'Select from matching warp routes',
      choices: routes.map(([routeId, _]) => ({
        value: routeId,
      })),
    });
    warpCoreConfig = matching[chosenRouteId];
    warpId = chosenRouteId;
  }

  return [warpId, warpCoreConfig];
}
