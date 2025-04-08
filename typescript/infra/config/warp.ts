import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  MultiProvider,
  OwnableConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

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
import { getArbitrumEthereumSolanaTreasureSMOLWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumEthereumSolanaTreasureSMOLWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import { getBaseEthereumLumiaprismETHWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseEthereumLumiaprismETHWarpConfig.js';
import { getBaseEthereumSuperseedCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseEthereumSuperseedCBBTCWarpConfig.js';
import {
  getTRUMPWarpConfig,
  getTrumpchainTRUMPWarpConfig,
} from './environments/mainnet3/warp/configGetters/getBaseSolanaTRUMPWarpConfig.js';
import { getBaseZeroNetworkCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseZeroNetworkCBBTCWarpConfig.js';
import { getBobaBsquaredSoneiumSwellUBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBobaBsquaredSwellUBTCWarpConfig.js';
import { getBscHyperevmEnzoBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBscHyperevmEnzoBTCWarpConfig.js';
import { getBscHyperevmSTBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBscHyperevmSTBTCWarpConfig.js';
import { getEclipseEthereumSolanaUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumSolanaUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import { getEclipseStrideTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideSTTIAWarpConfig.js';
import { getEclipseStrideStTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideTIAWarpConfig.js';
import { getEthereumFormFORMWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormFORMWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumInkUSDCConfig } from './environments/mainnet3/warp/configGetters/getEthereumInkUSDCWarpConfig.js';
import { getEthereumLineaTurtleWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumLineaTurtleWarpConfig.js';
import { getEthereumSuperseedUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumSuperseedUSDCWarpConfig.js';
import { getEthereumVictionETHWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionETHWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getEthereumZircuitRe7LRTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumZircuitRe7LRTWarpConfig.js';
import { getInevmInjectiveINJWarpConfig } from './environments/mainnet3/warp/configGetters/getInevmInjectiveINJWarpConfig.js';
import { getMantapacificNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getMantapacificNeutronTiaWarpConfig.js';
import { getMintSolanaMintWarpConfig } from './environments/mainnet3/warp/configGetters/getMintSolanaMintWarpConfig.js';
import {
  getEZETHSTAGEGnosisSafeBuilderStrategyConfig,
  getRenzoEZETHSTAGEWarpConfig,
} from './environments/mainnet3/warp/configGetters/getRenzoEZETHSTAGEWarpConfig.js';
import {
  getEZETHGnosisSafeBuilderStrategyConfig,
  getRenzoEZETHWarpConfig,
} from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import {
  getPZETHSTAGEGnosisSafeBuilderStrategyConfig,
  getRenzoPZETHStagingWarpConfig,
} from './environments/mainnet3/warp/configGetters/getRenzoPZETHSTAGEWarpConfig.js';
import { getRenzoPZETHWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';
import { getREZBaseEthereumWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoREZBaseEthereum.js';
import { getSuperTokenProductionWarpConfig } from './environments/mainnet3/warp/configGetters/getSuperTokenWarpConfig.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';
import { DEFAULT_REGISTRY_URI } from './registry.js';

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
  [WarpRouteIds.ArbitrumBaseBerachainBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoUnichainZircuitEZETH]:
    getRenzoEZETHWarpConfig,
  [WarpRouteIds.ArbitrumBaseBerachainBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoUnichainZircuitEZETHSTAGE]:
    getRenzoEZETHSTAGEWarpConfig,
  [WarpRouteIds.InevmInjectiveINJ]: getInevmInjectiveINJWarpConfig,
  [WarpRouteIds.ArbitrumAvalancheBaseFlowmainnetFormOptimismSolanamainnetWorldchainTRUMP]:
    getTRUMPWarpConfig,
  [WarpRouteIds.SolanamainnetTrumpchainTRUMP]: getTrumpchainTRUMPWarpConfig,
  [WarpRouteIds.EthereumFormFORM]: getEthereumFormFORMWarpConfig,
  [WarpRouteIds.EthereumInkUSDC]: getEthereumInkUSDCConfig,
  [WarpRouteIds.EthereumVictionETH]: getEthereumVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETH]:
    getRenzoPZETHWarpConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETHSTAGE]:
    getRenzoPZETHStagingWarpConfig,
  [WarpRouteIds.MantapacificNeutronTIA]: getMantapacificNeutronTiaWarpConfig,
  [WarpRouteIds.EclipseEthereumSolanaUSDT]:
    getEclipseEthereumSolanaUSDTWarpConfig,
  [WarpRouteIds.EclipseEthereumWBTC]: getEclipseEthereumWBTCWarpConfig,
  [WarpRouteIds.BaseZeroNetworkCBBTC]: getBaseZeroNetworkCBBTCWarpConfig,
  [WarpRouteIds.BaseEthereumREZ]: getREZBaseEthereumWarpConfig,
  [WarpRouteIds.ArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDT]:
    getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDC]:
    getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDC,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumGnosisLiskMantleModeOptimismPolygonScrollZeroNetworkZoraMainnet]:
    getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig,
  [WarpRouteIds.EclipseStrideTIA]: getEclipseStrideTiaWarpConfig,
  [WarpRouteIds.EclipseStrideSTTIA]: getEclipseStrideStTiaWarpConfig,
  [WarpRouteIds.AppchainBaseUSDC]: getAppChainBaseUSDCWarpConfig,
  [WarpRouteIds.BobaBsquaredSoneiumSwellUBTC]:
    getBobaBsquaredSoneiumSwellUBTCWarpConfig,
  [WarpRouteIds.EthereumZircuitRe7LRT]: getEthereumZircuitRe7LRTWarpConfig,
  [WarpRouteIds.BaseEthereumSuperseedCBBTC]:
    getBaseEthereumSuperseedCBBTCWarpConfig,
  [WarpRouteIds.EthereumSuperseedUSDC]: getEthereumSuperseedUSDCWarpConfig,
  [WarpRouteIds.ArbitrumEthereumSolanaTreasureSMOL]:
    getArbitrumEthereumSolanaTreasureSMOLWarpConfig,
  // TODO: uncomment after merging the staging route to registry
  // this has been commented out as it leads to check-warp-deploy cron job failing
  // [WarpRouteIds.SuperTokenStaging]: getSuperTokenStagingWarpConfig,
  [WarpRouteIds.SuperUSDT]: getSuperTokenProductionWarpConfig,
  [WarpRouteIds.MintSolanaMINT]: getMintSolanaMintWarpConfig,
  [WarpRouteIds.BaseEthereumLumiaprismETH]:
    getBaseEthereumLumiaprismETHWarpConfig,
  [WarpRouteIds.BscHyperevmEnzoBTC]: getBscHyperevmEnzoBTCWarpConfig,
  [WarpRouteIds.BscHyperevmSTBTC]: getBscHyperevmSTBTCWarpConfig,
  [WarpRouteIds.EthereumLineaTURTLE]: getEthereumLineaTurtleWarpConfig,
};

type StrategyConfigGetter = () => ChainSubmissionStrategy;
export const strategyConfigGetterMap: Record<string, StrategyConfigGetter> = {
  [WarpRouteIds.ArbitrumBaseBerachainBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoUnichainZircuitEZETH]:
    getEZETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.ArbitrumBaseBerachainBlastBscEthereumFraxtalLineaModeOptimismSeiSwellTaikoUnichainZircuitEZETHSTAGE]:
    getEZETHSTAGEGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETH]:
    getEZETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETHSTAGE]:
    getPZETHSTAGEGnosisSafeBuilderStrategyConfig,
};

/**
 * Retrieves the Warp configuration for the specified Warp route ID by fetching it from the FileSystemRegistry and GithubRegistry
 */
async function getConfigFromMergedRegistry(
  _routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  warpRouteId: string,
  registryUris: string[],
): Promise<ChainMap<HypTokenRouterConfig>> {
  const registry = getRegistry({
    registryUris,
    enableProxy: true,
  });
  const warpRoute = await registry.getWarpDeployConfig(warpRouteId);
  assert(warpRoute, `Warp route Config not found for ${warpRouteId}`);

  return populateWarpRouteMailboxAddresses(warpRoute, registry);
}

/**
 * Populates warp route configuration by filling in mailbox addresses for each chain entry
 * @param warpRoute The warp route configuration
 * @param registry The registry to fetch chain addresses from if needed
 * @returns Populated configuration with mailbox addresses for all chains
 */
async function populateWarpRouteMailboxAddresses(
  warpRoute: WarpRouteDeployConfig,
  registry: IRegistry,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const mailboxPromises = objMap(warpRoute, async (chainName, config) => {
    const mailbox =
      config.mailbox || (await registry.getChainAddresses(chainName))?.mailbox;

    assert(mailbox, `Mailbox not found for ${chainName}`);

    return {
      ...config,
      mailbox,
    };
  });

  return promiseObjAll(mailboxPromises);
}

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
  warpRouteId: string,
  registryUris = [DEFAULT_REGISTRY_URI],
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

  return getConfigFromMergedRegistry(
    routerConfigWithoutOwner,
    abacusWorksEnvOwnerConfig,
    warpRouteId,
    registryUris,
  );
}
