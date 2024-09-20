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
import { getRenzoEZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConifg.js';

export enum WarpRouteIds {
  Ancient8EthereumUSDC = 'USDC/ancient8-ethereum',
  ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH = 'EZETH/arbitrum-base-blast-bsc-ethereum-fraxtal-linea-mode-optimism-zircuit',
  ArbitrumNeutronEclip = 'ECLIP/arbitrum-neutron',
  ArbitrumNeutronTIA = 'TIA/arbitrum-neutron',
  EthereumInevmUSDC = 'USDC/ethereum-inevm',
  EthereumInevmUSDT = 'USDT/ethereum-inevm',
  EthereumEclipseTETH = 'tETH/eclipsemainnet-ethereum',
  EthereumEclipseUSDC = 'USDC/eclipsemainnet-ethereum-solanamainnet',
  EthereumVictionETH = 'ETH/ethereum-viction',
  EthereumVictionUSDC = 'USDC/ethereum-viction',
  EthereumVictionUSDT = 'USDT/ethereum-viction',
  InevmInjectiveINJ = 'INJ/inevm-injective',
  MantapacificNeutronTIA = 'TIA/mantapacific-neutron',
}

type WarpConfigGetterWithConfig = (
  routerConfig: ChainMap<RouterConfig>,
) => Promise<ChainMap<TokenRouterConfig>>;

type WarpConfigGetterWithoutConfig = () => Promise<ChainMap<TokenRouterConfig>>;

export const warpConfigGetterMap: Record<
  string,
  WarpConfigGetterWithConfig | WarpConfigGetterWithoutConfig
> = {
  [WarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [WarpRouteIds.ArbitrumNeutronEclip]: getArbitrumNeutronEclipWarpConfig,
  [WarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [WarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [WarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.MantapacificNeutronTIA]: getMantapacificNeutronTiaWarpConfig,
  [WarpRouteIds.EthereumEclipseTETH]: getEthereumEclipseTETHWarpConfig,
  [WarpRouteIds.EthereumEclipseUSDC]: getEthereumEclipseUSDCWarpConfig,
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
