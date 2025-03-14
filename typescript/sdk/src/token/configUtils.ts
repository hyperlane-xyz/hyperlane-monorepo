import { zeroAddress } from 'viem';

import {
  Address,
  TransformObjectTransformer,
  objMap,
  transformObj,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { DestinationGas, RemoteRouters } from '../router/types.js';
import { ChainMap } from '../types.js';
import { sortArraysInConfig } from '../utils/ism.js';
import { WarpCoreConfig } from '../warp/types.js';

import { gasOverhead } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { HypTokenRouterConfig, WarpRouteDeployConfig } from './types.js';

/**
 * Gets gas configuration for a chain
 */
const getGasConfig = (
  warpDeployConfig: WarpRouteDeployConfig,
  chain: string,
): string =>
  warpDeployConfig[chain].gas?.toString() ||
  gasOverhead(warpDeployConfig[chain].type).toString();

export function getDefaultRemoteRouterAndDestinationGasConfig(
  multiProvider: MultiProvider,
  chain: string,
  deployedRoutersAddresses: ChainMap<Address>,
  warpDeployConfig: WarpRouteDeployConfig,
): [RemoteRouters, DestinationGas] {
  const remoteRouters: RemoteRouters = {};
  const destinationGas: DestinationGas = {};

  const otherChains = multiProvider
    .getRemoteChains(chain)
    .filter((c) => Object.keys(deployedRoutersAddresses).includes(c));

  for (const otherChain of otherChains) {
    const domainId = multiProvider.getDomainId(otherChain);

    remoteRouters[domainId] = {
      address: deployedRoutersAddresses[otherChain],
    };

    destinationGas[domainId] = getGasConfig(warpDeployConfig, otherChain);
  }

  return [remoteRouters, destinationGas];
}

export function getRouterAddressesFromWarpCoreConfig(
  warpCoreConfig: WarpCoreConfig,
): ChainMap<Address> {
  return Object.fromEntries(
    warpCoreConfig.tokens.map((token) => [
      token.chainName,
      token.addressOrDenom,
    ]),
  ) as ChainMap<Address>;
}

export async function expandWarpDeployConfig(
  multiProvider: MultiProvider,
  warpDeployConfig: WarpRouteDeployConfig,
  deployedRoutersAddresses: ChainMap<Address>,
): Promise<WarpRouteDeployConfig> {
  const derivedTokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
    multiProvider,
    warpDeployConfig,
  );
  return objMap(warpDeployConfig, (chain, config) => {
    const [remoteRouters, destinationGas] =
      getDefaultRemoteRouterAndDestinationGasConfig(
        multiProvider,
        chain,
        deployedRoutersAddresses,
        warpDeployConfig,
      );

    return {
      // Default Expansion
      ...derivedTokenMetadata,
      remoteRouters,
      destinationGas,
      hook: zeroAddress,
      interchainSecurityModule: zeroAddress,
      proxyAdmin: { owner: config.owner },

      // User-specified config takes precedence
      ...config,
    };
  });
}

const transformWarpDeployConfigToCheck: TransformObjectTransformer = (
  obj: any,
  propPath: ReadonlyArray<string>,
) => {
  // Needed to check if we are currently inside the remoteRouters object
  const maybeRemoteRoutersKey = propPath[propPath.length - 3];
  const parentKey = propPath[propPath.length - 1];

  // Remove the address and ownerOverrides fields if we are not inside the
  // remoteRouters property
  if (
    (parentKey === 'address' && maybeRemoteRoutersKey !== 'remoteRouters') ||
    parentKey === 'ownerOverrides'
  ) {
    return undefined;
  }

  if (typeof obj === 'string' && parentKey !== 'type') {
    return obj.toLowerCase();
  }

  return obj;
};

type HypTokenRouterConfigKey = keyof HypTokenRouterConfig;
const KEYS_TO_IGNORE: HypTokenRouterConfigKey[] = ['totalSupply'];

function sanitizeConfig(obj: HypTokenRouterConfig): any {
  // Remove keys from obj
  return Object.fromEntries(
    Object.entries(obj).filter(
      ([key]) => !KEYS_TO_IGNORE.includes(key as HypTokenRouterConfigKey),
    ),
  );
}

export function formatConfigToCheck(
  obj: HypTokenRouterConfig,
): HypTokenRouterConfig {
  return sanitizeConfig(
    sortArraysInConfig(transformObj(obj, transformWarpDeployConfigToCheck)),
  );
}
