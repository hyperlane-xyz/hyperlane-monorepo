import {
  ChainMap,
  HypTokenRouterConfig,
  MultiProvider,
  OwnableConfig,
} from '@hyperlane-xyz/sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import {
  EnvironmentConfig,
  getRouterConfigsForAllVms,
} from '../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../src/config/warp.js';

import { getAncient8EthereumUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAncient8EthereumUSDCWarpConfig.js';
import { getAppChainBaseUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAppchainBaseUSDCWarpConfig.js';
import { getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig.js';
import { getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC } from './environments/mainnet3/warp/configGetters/getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDCWarpConfig.js';
import { getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBscEthereumMantleModePolygonScrollZeronetworkUSDTWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import {
  getTRUMPWarpConfig,
  getTrumpchainTRUMPWarpConfig,
} from './environments/mainnet3/warp/configGetters/getBaseSolanaTRUMPWarpConfig.js';
import { getBaseZeroNetworkCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseZeroNetworkCBBTCWarpConfig.js';
import { getBobaBsquaredSwellUBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBobaBsquaredSwellUBTCWarpConfig.js';
import { getEclipseEthereumSolanaUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumSolanaUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import { getEclipseStrideTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideSTTIAWarpConfig.js';
import { getEclipseStrideStTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideTIAWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumInkUSDCConfig } from './environments/mainnet3/warp/configGetters/getEthereumInkUSDCWarpConfig.js';
import {
  getEthereumSuperseedCBBTCWarpConfig,
  getEthereumSuperseedUSDCWarpConfig,
} from './environments/mainnet3/warp/configGetters/getEthereumSuperseedWarpConfig.js';
import { getEthereumVictionETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionETHWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getEthereumZircuitRe7LRTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumZircuitRe7LRTWarpConfig.js';
import { getInevmInjectiveINJWarpConfig } from './environments/mainnet3/warp/configGetters/getInevmInjectiveINJWarpConfig.js';
import { getMantapacificNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getMantapacificNeutronTiaWarpConfig.js';
import { getRenzoEZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getRenzoPZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';
import { getGithubRegistry } from './registry.js';

type WarpConfigGetter = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  warpRouteId: string,
) => Promise<ChainMap<HypTokenRouterConfig>>;

export const warpConfigGetterMap: Record<string, WarpConfigGetter> = {
  [WarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [WarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [WarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [WarpRouteIds.ArbitrumAvalancheBaseFlowmainnetFormOptimismSolanamainnetWorldchainTRUMP]:
    getTRUMPWarpConfig,
  [WarpRouteIds.SolanamainnetTrumpchainTRUMP]: getTrumpchainTRUMPWarpConfig,
  [WarpRouteIds.EthereumInkUSDC]: getEthereumInkUSDCConfig,
  [WarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.EthereumSwellZircuitPZETH]: getRenzoPZETHWarpConfig,
  [WarpRouteIds.MantapacificNeutronTIA]: getMantapacificNeutronTiaWarpConfig,
  [WarpRouteIds.EclipseEthereumSolanaUSDT]:
    getEclipseEthereumSolanaUSDTWarpConfig,
  [WarpRouteIds.EclipseEthereumWBTC]: getEclipseEthereumWBTCWarpConfig,
  [WarpRouteIds.BaseZeroNetworkCBBTC]: getBaseZeroNetworkCBBTCWarpConfig,
  [WarpRouteIds.ArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDT]:
    getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDC]:
    getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumGnosisLiskMantleModeOptimismPolygonScrollZeroNetworkZoraMainnet]:
    getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig,
  [WarpRouteIds.EclipseStrideTIA]: getEclipseStrideTiaWarpConfig,
  [WarpRouteIds.EclipseStrideSTTIA]: getEclipseStrideStTiaWarpConfig,
  [WarpRouteIds.AppchainBaseUSDC]: getAppChainBaseUSDCWarpConfig,
  [WarpRouteIds.BobaBsquaredSwellUBTC]: getBobaBsquaredSwellUBTCWarpConfig,
  [WarpRouteIds.EthereumZircuitRe7LRT]: getEthereumZircuitRe7LRTWarpConfig,
  [WarpRouteIds.EthereumSuperseedCBBTC]: getEthereumSuperseedCBBTCWarpConfig,
  [WarpRouteIds.EthereumSuperseedUSDC]: getEthereumSuperseedUSDCWarpConfig,
};

async function getConfigFromGithub(
  _routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const warpRoute = await getGithubRegistry().getWarpDeployConfig(warpRouteId);
  assert(warpRoute, `Warp route Config not found for ${warpRouteId}`);
  return warpRoute;
}

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
  warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const routerConfig = await getRouterConfigsForAllVms(
    envConfig,
    multiProvider,
  );
  // Strip the owners from the router config
  const routerConfigWithoutOwner = objMap(routerConfig, (_chain, config) => {
    const {
      owner: _owner,
      ownerOverrides: _ownerOverrides,
      ...configWithoutOwner
    } = config;
    return configWithoutOwner;
  });
  // Isolate the owners from the router config
  const abacusWorksEnvOwnerConfig = objMap(routerConfig, (_chain, config) => {
    const { owner, ownerOverrides } = config;
    return {
      owner,
      ownerOverrides,
    };
  });

  const warpConfigGetter = warpConfigGetterMap[warpRouteId];
  if (warpConfigGetter) {
    return warpConfigGetter(
      routerConfigWithoutOwner,
      abacusWorksEnvOwnerConfig,
      warpRouteId,
    );
  }

  return getConfigFromGithub(
    routerConfigWithoutOwner,
    abacusWorksEnvOwnerConfig,
    warpRouteId,
  );
}
