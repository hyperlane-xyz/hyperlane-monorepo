import {
  ChainMap,
  MultiProvider,
  RouterConfig,
  TokenRouterConfig,
} from '@hyperlane-xyz/sdk';

import { getHyperlaneCore } from '../scripts/core-utils.js';
import { EnvironmentConfig } from '../src/config/environment.js';

import { getAncient8EthereumUSDCWarpConfig } from './environments/mainnet3/warp/getAncient8EthereumUSDCWrapConfig.js';

export const warpConfigGetterMap: Record<
  string,
  (routerConfig: ChainMap<RouterConfig>) => Promise<ChainMap<TokenRouterConfig>>
> = {
  // will make the keys an enum
  'USDC/ancient8-ethereum': getAncient8EthereumUSDCWarpConfig,
};

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
  warpRouteId: string,
): Promise<ChainMap<TokenRouterConfig>> {
  const { core } = await getHyperlaneCore(envConfig.environment, multiProvider);
  const routerConfig = core.getRouterConfig(envConfig.owners);

  const getWarpConfig = warpConfigGetterMap[warpRouteId];
  if (!getWarpConfig) {
    throw new Error(`Unknown warp route: ${warpRouteId}`);
  }

  return getWarpConfig(routerConfig);
}
