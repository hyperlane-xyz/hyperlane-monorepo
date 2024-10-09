import {
  ChainMap,
  MultiProvider,
  RouterConfig,
  TokenRouterConfig,
} from '@hyperlane-xyz/sdk';

import { getHyperlaneCore } from '../scripts/core-utils.js';
import { EnvironmentConfig } from '../src/config/environment.js';

import { getAncient8EthereumUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAncient8EthereumUSDCWarpConfig.js';
import { getArbitrumNeutronEclipWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronEclipWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import { getEthereumEclipseTETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumEclipseTETHWarpConfig.js';
import { getEthereumEclipseUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumEclipseUSDCWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumVictionETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionETHWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getInevmInjectiveINJWarpConfig } from './environments/mainnet3/warp/configGetters/getInevmInjectiveINJWarpConfig.js';
import { getMantapacificNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getMantapacificNeutronTiaWarpConfig.js';
import { getRenzoEZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getRenzoPZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';
import { CheckerWarpRouteIds } from './environments/mainnet3/warp/warpIds.js';

type WarpConfigGetterWithConfig = (
  routerConfig: ChainMap<RouterConfig>,
) => Promise<ChainMap<TokenRouterConfig>>;

type WarpConfigGetterWithoutConfig = () => Promise<ChainMap<TokenRouterConfig>>;

export const warpConfigGetterMap: Record<
  string,
  WarpConfigGetterWithConfig | WarpConfigGetterWithoutConfig
> = {
  [CheckerWarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [CheckerWarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [CheckerWarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [CheckerWarpRouteIds.ArbitrumNeutronEclip]: getArbitrumNeutronEclipWarpConfig,
  [CheckerWarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [CheckerWarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [CheckerWarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [CheckerWarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [CheckerWarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [CheckerWarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [CheckerWarpRouteIds.MantapacificNeutronTIA]:
    getMantapacificNeutronTiaWarpConfig,
  [CheckerWarpRouteIds.EthereumZircuitPZETH]: getRenzoPZETHWarpConfig,
};

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
  warpRouteId: string,
): Promise<ChainMap<TokenRouterConfig>> {
  const { core } = await getHyperlaneCore(envConfig.environment, multiProvider);
  const routerConfig = core.getRouterConfig(envConfig.owners);

  const warpConfigGetter = warpConfigGetterMap[warpRouteId];
  if (!warpConfigGetter) {
    throw new Error(`Unknown warp route: ${warpRouteId}`);
  }

  if (warpConfigGetter.length === 1) {
    return warpConfigGetter(routerConfig);
  } else {
    return (warpConfigGetter as WarpConfigGetterWithoutConfig)();
  }
}
