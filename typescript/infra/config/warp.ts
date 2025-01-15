import {
  ChainMap,
  HypTokenRouterConfig,
  MultiProvider,
  OwnableConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

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
import { getArbitrumEthereumZircuitAmphrETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumEthereumZircuitAmphrETHWarpConfig.js';
import { getArbitrumNeutronEclipWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronEclipWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import { getArtelaBaseUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getArtelaBaseUSDCWarpConfig.js';
import { getArtelaBaseWETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArtelaBaseWETHWarpConfig.js';
import { getBaseFormAIXBTWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseFormAIXBTWarpConfig.js';
import { getBaseFormGAMEWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseFormGAMEWarpConfig.js';
import { getBaseZeroNetworkCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseZeroNetworkCBBTCWarpConfig.js';
import { getBobaBsquaredSwellUBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBobaBsquaredSwellUBTCWarpConfig.js';
import { getBscEthereumLumiaPrismPNDRWarpConfig } from './environments/mainnet3/warp/configGetters/getBscEthereumLumiaPNDRWarpConfig.js';
import { getEclipseEthereumApxEthWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumApxETHWarpConfig.js';
import { getEclipseEthereumSolanaUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumSolanaUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import { getEclipseEthereumWeEthsWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWeETHsWarpConfig.js';
import { getEclipseStrideTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideSTTIAWarpConfig.js';
import { getEclipseStrideStTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideTIAWarpConfig.js';
import { getEthereumBscLUMIAWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumBscLumiaLUMIAWarpConfig.js';
import { getEthereumFlowCbBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFlowCbBTCWarpConfig.js';
import { getEthereumFormUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormUSDCWarpConfig.js';
import { getEthereumFormUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormUSDTWarpConfig.js';
import { getEthereumFormWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormWBTCWarpConfig.js';
import { getEthereumFormWSTETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormWSTETHWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumInkUSDCConfig } from './environments/mainnet3/warp/configGetters/getEthereumInkUSDCWarpConfig.js';
import { getEthereumSeiFastUSDWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumSeiFastUSDWarpConfig.js';
import { getEthereumSeiPumpBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumSeiPumpBTCWarpConfig.js';
import { getEthereumVictionETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionETHWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getEthereumZircuitRe7LRTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumZircuitRe7LRTWarpConfig.js';
import { getEthereumZircuitRstETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumZircuitRstETHWarpConfig.js';
import { getInevmInjectiveINJWarpConfig } from './environments/mainnet3/warp/configGetters/getInevmInjectiveINJWarpConfig.js';
import { getMantapacificNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getMantapacificNeutronTiaWarpConfig.js';
import { getRenzoEZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getRenzoPZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';
import {
  getEthereumSuperseedUSDTConfig,
  getOptimismSuperseedOPConfig,
} from './environments/mainnet3/warp/configGetters/getSuperseedWarpConfigs.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';

type WarpConfigGetter = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
) => Promise<ChainMap<HypTokenRouterConfig>>;

export const warpConfigGetterMap: Record<string, WarpConfigGetter> = {
  [WarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [WarpRouteIds.ArbitrumEthereumZircuitAMPHRETH]:
    getArbitrumEthereumZircuitAmphrETHWarpConfig,
  [WarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [WarpRouteIds.ArbitrumNeutronEclip]: getArbitrumNeutronEclipWarpConfig,
  [WarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [WarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [WarpRouteIds.BscEthereumLumiaPrismPNDR]:
    getBscEthereumLumiaPrismPNDRWarpConfig,
  [WarpRouteIds.EthereumFlowCbBTC]: getEthereumFlowCbBTCWarpConfig,
  [WarpRouteIds.EthereumInkUSDC]: getEthereumInkUSDCConfig,
  [WarpRouteIds.EthereumSeiFastUSD]: getEthereumSeiFastUSDWarpConfig,
  [WarpRouteIds.EthereumSeiPumpBTC]: getEthereumSeiPumpBTCWarpConfig,
  [WarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.EthereumSwellZircuitPZETH]: getRenzoPZETHWarpConfig,
  [WarpRouteIds.EthereumBscLumiaLUMIA]: getEthereumBscLUMIAWarpConfig,
  [WarpRouteIds.MantapacificNeutronTIA]: getMantapacificNeutronTiaWarpConfig,
  [WarpRouteIds.EclipseEthereumApxEth]: getEclipseEthereumApxEthWarpConfig,
  [WarpRouteIds.EclipseEthereumSolanaUSDT]:
    getEclipseEthereumSolanaUSDTWarpConfig,
  [WarpRouteIds.EclipseEthereumWBTC]: getEclipseEthereumWBTCWarpConfig,
  [WarpRouteIds.EclipseEthereumWeETHs]: getEclipseEthereumWeEthsWarpConfig,
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
  [WarpRouteIds.EthereumFormUSDT]: getEthereumFormUSDTWarpConfig,
  [WarpRouteIds.EthereumFormUSDC]: getEthereumFormUSDCWarpConfig,
  [WarpRouteIds.EthereumSuperseedUSDT]: getEthereumSuperseedUSDTConfig,
  [WarpRouteIds.OptimismSuperseedOP]: getOptimismSuperseedOPConfig,
  [WarpRouteIds.EthereumZircuitRstETH]: getEthereumZircuitRstETHWarpConfig,
  [WarpRouteIds.EthereumFormWBTC]: getEthereumFormWBTCWarpConfig,
  [WarpRouteIds.EthereumFormWSTETH]: getEthereumFormWSTETHWarpConfig,
  [WarpRouteIds.BaseFormAIXBT]: getBaseFormAIXBTWarpConfig,
  [WarpRouteIds.BaseFormGAME]: getBaseFormGAMEWarpConfig,
  [WarpRouteIds.ArtelaBaseUSDC]: getArtelaBaseUSDCWarpConfig,
  [WarpRouteIds.ArtelaBaseWETH]: getArtelaBaseWETHWarpConfig,
};

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
  if (!warpConfigGetter) {
    throw new Error(
      `Unknown warp route: ${warpRouteId}, must be one of: ${Object.keys(
        warpConfigGetterMap,
      ).join(', ')}`,
    );
  }

  return warpConfigGetter(routerConfigWithoutOwner, abacusWorksEnvOwnerConfig);
}
