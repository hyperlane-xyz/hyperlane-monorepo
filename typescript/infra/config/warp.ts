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
import {
  getArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIAWarpConfig,
  getLUMIAGnosisSafeBuilderStrategyConfig,
} from './environments/mainnet3/warp/configGetters/getArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIAWarpConfig.js';
import { getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig.js';
import {
  getArbitrumBaseEthereumLumiaprismOptimismPolygonETHGnosisSafeBuilderStrategyConfig,
  getArbitrumBaseEthereumLumiaprismOptimismPolygonETHWarpConfig,
} from './environments/mainnet3/warp/configGetters/getArbitrumBaseEthereumLumiaprismOptimismPolygonETHWarpConfig.js';
import { getArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumBaseEthereumOptimismPolygonZeroNetworkUSDCWarpConfig.js';
import { getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig.js';
import { getArbitrumNeutronTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getArbitrumNeutronTiaWarpConfig.js';
import { getBaseEthereumSuperseedCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseEthereumSuperseedCBBTCWarpConfig.js';
import {
  getTRUMPWarpConfig,
  getTrumpchainTRUMPWarpConfig,
} from './environments/mainnet3/warp/configGetters/getBaseSolanaTRUMPWarpConfig.js';
import { getBaseZeroNetworkCBBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseZeroNetworkCBBTCWarpConfig.js';
import { getBscHyperevmEnzoBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBscHyperevmEnzoBTCWarpConfig.js';
import { getBscHyperevmSTBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getBscHyperevmSTBTCWarpConfig.js';
import { getBscMilkywayMILKWarpConfig } from './environments/mainnet3/warp/configGetters/getBscMilkywayMILKWarpConfig.js';
import {
  getBsquaredUBTCWarpConfig,
  getUbtcGnosisSafeBuilderStrategyConfigGenerator,
} from './environments/mainnet3/warp/configGetters/getBsquaredUBTCWarpConfig.js';
import { getEclipseEthereumESWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumESWarpConfig.js';
import { getEclipseEthereumSolanaUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumSolanaUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import { getEclipseStrideTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideSTTIAWarpConfig.js';
import { getEclipseStrideStTiaWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseStrideTIAWarpConfig.js';
import { getEthereumFormFORMWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumFormFORMWarpConfig.js';
import { getEthereumInevmUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDCWarpConfig.js';
import { getEthereumInevmUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumInevmUSDTWarpConfig.js';
import { getEthereumInkUSDCConfig } from './environments/mainnet3/warp/configGetters/getEthereumInkUSDCWarpConfig.js';
import { getEthereumLineaTurtleWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumLineaTurtleWarpConfig.js';
import { getEthereumSolanaTreasureSMOLWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumSolanaTreasureSMOLWarpConfig.js';
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
import {
  getRezStagingGnosisSafeBuilderStrategyConfig,
  getRezStagingWarpConfig,
} from './environments/mainnet3/warp/configGetters/getRenzoREZStaging.js';
import {
  getoUSDTTokenProductionWarpConfig,
  getoUSDTTokenStagingWarpConfig,
} from './environments/mainnet3/warp/configGetters/getoUSDTTokenWarpConfig.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';
import { getCCTPWarpConfig } from './environments/testnet4/warp/getCCTPConfig.js';
import { DEFAULT_REGISTRY_URI } from './registry.js';

type WarpConfigGetter = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  warpRouteId: string,
) => Promise<ChainMap<HypTokenRouterConfig>>;

export const warpConfigGetterMap: Record<string, WarpConfigGetter> = {
  [WarpRouteIds.BscMilkywayMILK]: getBscMilkywayMILKWarpConfig,
  [WarpRouteIds.Ancient8EthereumUSDC]: getAncient8EthereumUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDC]: getEthereumInevmUSDCWarpConfig,
  [WarpRouteIds.EthereumInevmUSDT]: getEthereumInevmUSDTWarpConfig,
  [WarpRouteIds.ArbitrumNeutronTIA]: getArbitrumNeutronTiaWarpConfig,
  [WarpRouteIds.RenzoEZETH]: getRenzoEZETHWarpConfig,
  [WarpRouteIds.RenzoEZETHSTAGE]: getRenzoEZETHSTAGEWarpConfig,
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
  [WarpRouteIds.BaseEthereumREZSTAGING]: getRezStagingWarpConfig,
  [WarpRouteIds.ArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDT]:
    getArbitrumEthereumMantleModePolygonScrollZeroNetworkUSDTWarpConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDC]:
    getArbitrumBaseEthereumLiskOptimismPolygonZeroNetworkUSDCWarpConfig,
  [WarpRouteIds.ArbitrumBaseBlastBscEthereumGnosisLiskMantleModeOptimismPolygonScrollZeroNetworkZoraMainnet]:
    getArbitrumBaseBlastBscEthereumGnosisMantleModeOptimismPolygonScrollZeroNetworkZoraMainnetETHWarpConfig,
  [WarpRouteIds.EclipseStrideTIA]: getEclipseStrideTiaWarpConfig,
  [WarpRouteIds.EclipseStrideSTTIA]: getEclipseStrideStTiaWarpConfig,
  [WarpRouteIds.AppchainBaseUSDC]: getAppChainBaseUSDCWarpConfig,
  [WarpRouteIds.BsquaredUBTC]: getBsquaredUBTCWarpConfig,
  [WarpRouteIds.EthereumZircuitRe7LRT]: getEthereumZircuitRe7LRTWarpConfig,
  [WarpRouteIds.BaseEthereumSuperseedCBBTC]:
    getBaseEthereumSuperseedCBBTCWarpConfig,
  [WarpRouteIds.EthereumSuperseedUSDC]: getEthereumSuperseedUSDCWarpConfig,
  [WarpRouteIds.EthereumSolanaTreasureSMOL]:
    getEthereumSolanaTreasureSMOLWarpConfig,
  [WarpRouteIds.EclipseEthereumES]: getEclipseEthereumESWarpConfig,
  [WarpRouteIds.oUSDT]: getoUSDTTokenProductionWarpConfig,
  // TODO: uncomment after merging the staging route to registry
  // this has been commented out as it leads to check-warp-deploy cron job failing
  [WarpRouteIds.oUSDTSTAGE]: getoUSDTTokenStagingWarpConfig,
  [WarpRouteIds.MintSolanaMINT]: getMintSolanaMintWarpConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLumiaprismOptimismPolygonETH]:
    getArbitrumBaseEthereumLumiaprismOptimismPolygonETHWarpConfig,
  [WarpRouteIds.BscHyperevmEnzoBTC]: getBscHyperevmEnzoBTCWarpConfig,
  [WarpRouteIds.BscHyperevmSTBTC]: getBscHyperevmSTBTCWarpConfig,
  [WarpRouteIds.EthereumLineaTURTLE]: getEthereumLineaTurtleWarpConfig,
  [WarpRouteIds.ArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIA]:
    getArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIAWarpConfig,
  // Not present in the registry
  // [WarpRouteIds.TestnetCCTP]: getCCTPWarpConfig,
};

type StrategyConfigGetter = () => ChainSubmissionStrategy;
export const strategyConfigGetterMap: Record<string, StrategyConfigGetter> = {
  [WarpRouteIds.ArbitrumAvalancheBaseBscEthereumLumiaprismOptimismPolygonLUMIA]:
    getLUMIAGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.RenzoEZETH]: getEZETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.RenzoEZETHSTAGE]: getEZETHSTAGEGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.ArbitrumBaseEthereumLumiaprismOptimismPolygonETH]:
    getArbitrumBaseEthereumLumiaprismOptimismPolygonETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETH]:
    getEZETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BerachainEthereumSwellUnichainZircuitPZETHSTAGE]:
    getPZETHSTAGEGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BaseEthereumREZ]: getEZETHGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BaseEthereumREZSTAGING]:
    getRezStagingGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.BsquaredUBTC]: getUbtcGnosisSafeBuilderStrategyConfigGenerator,
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
 * Retrieves all Warp configurations for the specified Warp route ID by fetching it from the MergedRegistry
 * Also, populates their mailbox
 * Will return in the form { [warRouteId]: { ...config } }
 */
export async function getWarpConfigMapFromMergedRegistry(
  registryUris: string[],
): Promise<Record<string, ChainMap<HypTokenRouterConfig>>> {
  const registry = getRegistry({
    registryUris,
    enableProxy: true,
  });
  const warpRouteMap = await registry.getWarpDeployConfigs();
  assert(
    warpRouteMap,
    `Warp route Configs not found for registry URIs: ${registryUris.join(
      ', ',
    )}`,
  );
  return promiseObjAll(
    objMap(warpRouteMap, async (_, warpRouteConfig) =>
      populateWarpRouteMailboxAddresses(warpRouteConfig, registry),
    ),
  );
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
      ...(ownerOverrides ? { ownerOverrides } : {}),
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
