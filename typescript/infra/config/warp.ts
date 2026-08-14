import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  MultiProvider,
  OwnableConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { assert, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { getRouterConfigsForAllVms } from '../scripts/core-utils.js';
import { EnvironmentConfig } from '../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../src/config/warp.js';

import { getAleoUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAleoUSDCWarpConfig.js';
import { getAppChainBaseUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getAppchainBaseUSDCWarpConfig.js';
import { getTRUMPWarpConfig } from './environments/mainnet3/warp/configGetters/getBaseSolanaTRUMPWarpConfig.js';
import {
  getCCTPV1StrategyConfig,
  getCCTPV1WarpConfig,
  getCCTPV2FastWarpConfig,
  getCCTPV2StandardWarpConfig,
  getCCTPV2StrategyConfig,
} from './environments/mainnet3/warp/configGetters/getCCTPConfig.js';
import { getCarrChainCARRWarpConfig } from './environments/mainnet3/warp/configGetters/getCarrchainCARRWarpConfig.js';
import { getEclipseEthereumESWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumESWarpConfig.js';
import {
  getEclipseUSDTStrategyConfig,
  getEclipseUSDTWarpConfig,
} from './environments/mainnet3/warp/configGetters/getEclipseUSDTWarpConfig.js';
import { getEclipseEthereumWBTCWarpConfig } from './environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';
import {
  getEclipseUSDCSTAGEWarpConfig,
  getUSDCSTAGEEclipseFileSubmitterStrategyConfig,
  getUSDCSTAGEEclipseImpersonatedStrategyConfig,
} from './environments/mainnet3/warp/configGetters/getEclipseUSDCSTAGEWarpConfig.js';
import {
  getEclipseUSDCStrategyConfig,
  getEclipseUSDCWarpConfig,
} from './environments/mainnet3/warp/configGetters/getEclipseUSDCWarpConfig.js';
import { getElectroneumUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getElectroneumUSDCWarpConfig.js';
import {
  getIgraUSDCStrategyConfig,
  getIgraUSDCWarpConfig,
} from './environments/mainnet3/warp/configGetters/getIgraUSDCWarpConfig.js';
import {
  getEni1PieceWarpConfig,
  getEniEthWarpConfig,
  getEniUsdcWarpConfig,
  getEniUsdtWarpConfig,
  getEniWbtcWarpConfig,
} from './environments/mainnet3/warp/configGetters/getEniWarpConfigs.js';
import { getEthereumInkUSDCConfig } from './environments/mainnet3/warp/configGetters/getEthereumInkUSDCWarpConfig.js';
import { getEthereumVictionUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDCWarpConfig.js';
import { getEthereumVictionUSDTWarpConfig } from './environments/mainnet3/warp/configGetters/getEthereumVictionUSDTWarpConfig.js';
import { getMantraUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getMantraUSDCWarpConfig.js';
import { getMitosisMITOWarpConfig } from './environments/mainnet3/warp/configGetters/getMitosisMITOWarpConfig.js';
import { getETHStageWarpConfig } from './environments/mainnet3/warp/configGetters/getETHStageWarpConfig.js';
import { getParadexUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getParadexUSDCWarpConfig.js';
import { getPulsechainUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getPulsechainUSDCWarpConfig.js';
import { getEZETHFileSubmitterStrategyConfig } from './environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConfig.js';
import { getREZBaseEthereumWarpConfig } from './environments/mainnet3/warp/configGetters/getRenzoREZBaseEthereum.js';
import {
  getRezStagingGnosisSafeBuilderStrategyConfig,
  getRezStagingWarpConfig,
} from './environments/mainnet3/warp/configGetters/getRenzoREZStaging.js';
import { getSubtensorUSDCWarpConfig } from './environments/mainnet3/warp/configGetters/getSubtensorUSDCWarpConfig.js';
import {
  getSuperseedUSDCStrategyConfig,
  getSuperseedUSDCWarpConfig,
} from './environments/mainnet3/warp/configGetters/getSuperseedUSDCWarpConfig.js';
import {
  getVictionETHStrategyConfig,
  getVictionETHWarpConfig,
} from './environments/mainnet3/warp/configGetters/getVictionETHWarpConfig.js';
import {
  getoXAUTGnosisSafeSubmitterStrategyConfig,
  getoXAUTTokenProductionWarpConfig,
} from './environments/mainnet3/warp/configGetters/getoXAUTTokenWarpConfig.js';
import { WarpRouteIds } from './environments/mainnet3/warp/warpIds.js';
import { getCCTPWarpConfig as getTestnetCCTPWarpConfig } from './environments/testnet4/warp/getCCTPConfig.js';
import { DEFAULT_REGISTRY_URI } from './registry.js';
import { getUSDCCitreaIronBridgeWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDCCitreaIronBridgeWarpConfig.js';
import { getCrossMoonpayLocalBridgeWarpConfig } from './environments/mainnet3/warp/configGetters/getCrossMoonpayLocalBridgeWarpConfig.js';
import { getUSDCCitreaMoonpayWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDCCitreaMoonpayWarpConfig.js';
import { getUSDCCitreaMoonpayStagingWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDCCitreaMoonpayStagingWarpConfig.js';
import { getUSDTCitreaMoonpayWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayWarpConfig.js';
import { getUSDTCitreaMoonpayStagingWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDTCitreaMoonpayStagingWarpConfig.js';
import { getUSDTOftWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDTOftWarpConfig.js';
import { getUSDTOftLegacyWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDTOftLegacyWarpConfig.js';
import { getUSDTSTAGEWarpConfig } from './environments/mainnet3/warp/configGetters/getUSDTSTAGEWarpConfig.js';

type WarpConfigGetter = (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  warpRouteId: string,
) => Promise<ChainMap<HypTokenRouterConfig>>;

export const warpConfigGetterMap: Record<string, WarpConfigGetter> = {
  [WarpRouteIds.ArbitrumAvalancheBaseFlowmainnetFormOptimismSolanamainnetWorldchainTRUMP]:
    getTRUMPWarpConfig,
  [WarpRouteIds.EthereumInkUSDC]: getEthereumInkUSDCConfig,
  [WarpRouteIds.VictionETH]: getVictionETHWarpConfig,
  [WarpRouteIds.EthereumVictionUSDC]: getEthereumVictionUSDCWarpConfig,
  [WarpRouteIds.EthereumVictionUSDT]: getEthereumVictionUSDTWarpConfig,
  [WarpRouteIds.EclipseUSDC]: getEclipseUSDCWarpConfig,
  [WarpRouteIds.EclipseUSDCSTAGE]: getEclipseUSDCSTAGEWarpConfig,
  [WarpRouteIds.ETHSTAGEStage]: getETHStageWarpConfig,
  [WarpRouteIds.EclipseUSDT]: getEclipseUSDTWarpConfig,
  [WarpRouteIds.EclipseEthereumWBTC]: getEclipseEthereumWBTCWarpConfig,
  [WarpRouteIds.BaseEthereumREZ]: getREZBaseEthereumWarpConfig,
  [WarpRouteIds.BaseEthereumREZSTAGING]: getRezStagingWarpConfig,
  [WarpRouteIds.CarrChainCARR]: getCarrChainCARRWarpConfig,
  [WarpRouteIds.AppchainBaseUSDC]: getAppChainBaseUSDCWarpConfig,
  [WarpRouteIds.SuperseedUSDC]: getSuperseedUSDCWarpConfig,
  [WarpRouteIds.EclipseEthereumES]: getEclipseEthereumESWarpConfig,
  // TODO: uncomment after merging the staging route to registry
  // this has been commented out as it leads to check-warp-deploy cron job failing
  [WarpRouteIds.oXAUT]: getoXAUTTokenProductionWarpConfig,
  [WarpRouteIds.SubtensorUSDC]: getSubtensorUSDCWarpConfig,
  [WarpRouteIds.ParadexUSDC]: getParadexUSDCWarpConfig,
  [WarpRouteIds.TestnetCCTPV1]: getTestnetCCTPWarpConfig,
  [WarpRouteIds.MainnetCCTPV1]: getCCTPV1WarpConfig,
  [WarpRouteIds.MainnetCCTPV2Fast]: getCCTPV2FastWarpConfig,
  [WarpRouteIds.MainnetCCTPV2Standard]: getCCTPV2StandardWarpConfig,
  [WarpRouteIds.MitosisMITO]: getMitosisMITOWarpConfig,
  [WarpRouteIds.PulsechainUSDC]: getPulsechainUSDCWarpConfig,
  [WarpRouteIds.ElectroneumUSDC]: getElectroneumUSDCWarpConfig,
  [WarpRouteIds.IgraUSDC]: getIgraUSDCWarpConfig,
  [WarpRouteIds.MantraUSDC]: getMantraUSDCWarpConfig,
  [WarpRouteIds.EniETH]: getEniEthWarpConfig,
  [WarpRouteIds.EniWBTC]: getEniWbtcWarpConfig,
  [WarpRouteIds.EniUSDC]: getEniUsdcWarpConfig,
  [WarpRouteIds.EniUSDT]: getEniUsdtWarpConfig,
  [WarpRouteIds.Eni1Piece]: getEni1PieceWarpConfig,
  [WarpRouteIds.ModeUSDTSTAGE]: getUSDTSTAGEWarpConfig,
  [WarpRouteIds.AleoUSDC]: getAleoUSDCWarpConfig,
  [WarpRouteIds.USDTOft]: getUSDTOftWarpConfig,
  [WarpRouteIds.USDTOftLegacy]: getUSDTOftLegacyWarpConfig,
  [WarpRouteIds.USDCCitreaIronBridge]: getUSDCCitreaIronBridgeWarpConfig,
  [WarpRouteIds.USDCCitreaMoonpay]: getUSDCCitreaMoonpayWarpConfig,
  [WarpRouteIds.USDTCitreaMoonpay]: getUSDTCitreaMoonpayWarpConfig,
  [WarpRouteIds.USDCCitreaMoonpaySTAGING]:
    getUSDCCitreaMoonpayStagingWarpConfig,
  [WarpRouteIds.USDTCitreaMoonpaySTAGING]:
    getUSDTCitreaMoonpayStagingWarpConfig,
  [WarpRouteIds.CROSSMoonpayLocalBridgeUSDT]:
    getCrossMoonpayLocalBridgeWarpConfig,
};

type StrategyConfigGetter = () => ChainSubmissionStrategy;
export const strategyConfigGetterMap: Record<string, StrategyConfigGetter> = {
  [WarpRouteIds.BaseEthereumREZ]: getEZETHFileSubmitterStrategyConfig,
  [WarpRouteIds.BaseEthereumREZSTAGING]:
    getRezStagingGnosisSafeBuilderStrategyConfig,
  [WarpRouteIds.EclipseUSDC]: getEclipseUSDCStrategyConfig,
  [WarpRouteIds.EclipseUSDT]: getEclipseUSDTStrategyConfig,
  [WarpRouteIds.IgraUSDC]: getIgraUSDCStrategyConfig,
  [WarpRouteIds.EclipseUSDCSTAGE]:
    getUSDCSTAGEEclipseFileSubmitterStrategyConfig,
  [WarpRouteIds.MainnetCCTPV1]: getCCTPV1StrategyConfig,
  [WarpRouteIds.MainnetCCTPV2Fast]: getCCTPV2StrategyConfig,
  [WarpRouteIds.MainnetCCTPV2Standard]: getCCTPV2StrategyConfig,
  [WarpRouteIds.oXAUT]: getoXAUTGnosisSafeSubmitterStrategyConfig,
  [WarpRouteIds.SuperseedUSDC]: getSuperseedUSDCStrategyConfig,
  [WarpRouteIds.VictionETH]: getVictionETHStrategyConfig,
};

/** Sandbox strategy map — uses impersonated accounts for anvil fork testing */
export const sandboxStrategyConfigGetterMap: Record<
  string,
  StrategyConfigGetter
> = {
  [WarpRouteIds.EclipseUSDCSTAGE]:
    getUSDCSTAGEEclipseImpersonatedStrategyConfig,
};

/**
 * Retrieves the Warp configuration for the specified Warp route ID by fetching it from the FileSystemRegistry and GithubRegistry
 */
export async function getWarpDeployConfigFromMergedRegistry(
  warpRouteId: string,
  registryUris: string[],
): Promise<WarpRouteDeployConfigMailboxRequired> {
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
): Promise<Record<string, WarpRouteDeployConfigMailboxRequired>> {
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
): Promise<WarpRouteDeployConfigMailboxRequired> {
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
  forceRegistryConfig = false,
  getterInputs?: WarpConfigGetterInputs,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const { abacusWorksEnvOwnerConfig, routerConfigWithoutOwner } =
    getterInputs ?? (await getWarpConfigGetterInputs(multiProvider, envConfig));
  return getWarpConfigWithGetterInputs(
    warpRouteId,
    routerConfigWithoutOwner,
    abacusWorksEnvOwnerConfig,
    registryUris,
    forceRegistryConfig,
  );
}

export interface WarpConfigGetterInputs {
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>;
  routerConfigWithoutOwner: ChainMap<RouterConfigWithoutOwner>;
}

export async function getWarpConfigGetterInputs(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
): Promise<WarpConfigGetterInputs> {
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

  return {
    abacusWorksEnvOwnerConfig,
    routerConfigWithoutOwner,
  };
}

async function getWarpConfigWithGetterInputs(
  warpRouteId: string,
  routerConfigWithoutOwner: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  registryUris = [DEFAULT_REGISTRY_URI],
  forceRegistryConfig = false,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const warpConfigGetter = warpConfigGetterMap[warpRouteId];
  if (warpConfigGetter && !forceRegistryConfig) {
    return warpConfigGetter(
      routerConfigWithoutOwner,
      abacusWorksEnvOwnerConfig,
      warpRouteId,
    );
  }

  return getWarpDeployConfigFromMergedRegistry(warpRouteId, registryUris);
}
