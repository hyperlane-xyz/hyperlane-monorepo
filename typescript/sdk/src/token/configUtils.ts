import { zeroAddress } from 'viem';

import {
  Address,
  ProtocolType,
  TransformObjectTransformer,
  addressToBytes32,
  objMap,
  promiseObjAll,
  transformObj,
} from '@hyperlane-xyz/utils';

import { isProxy } from '../deploy/proxy.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { DestinationGas, RemoteRouters } from '../router/types.js';
import { ChainMap } from '../types.js';
import { sortArraysInConfig } from '../utils/ism.js';
import { WarpCoreConfig } from '../warp/types.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { gasOverhead } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
} from './types.js';

/**
 * Gets gas configuration for a chain
 */
const getGasConfig = (
  warpDeployConfig: WarpRouteDeployConfig,
  chain: string,
): string =>
  warpDeployConfig[chain].gas?.toString() ||
  gasOverhead(warpDeployConfig[chain].type).toString();

/**
 * Returns default router addresses and gas values for cross-chain communication.
 * For each remote chain:
 * - Sets up router addresses for message routing
 * - Configures gas values for message processing
 */
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
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  deployedRoutersAddresses: ChainMap<Address>,
): Promise<WarpRouteDeployConfigMailboxRequired> {
  const derivedTokenMetadata: TokenMetadataMap =
    await HypERC20Deployer.deriveTokenMetadata(multiProvider, warpDeployConfig);

  // If the token is on an EVM chain check if it is deployed as a proxy
  // to expand the proxy config too
  const isDeployedAsProxyByChain = await promiseObjAll(
    objMap(deployedRoutersAddresses, async (chain, address) => {
      if (!(multiProvider.getProtocol(chain) === ProtocolType.Ethereum)) {
        return false;
      }

      return isProxy(multiProvider.getProvider(chain), address);
    }),
  );

  return objMap(warpDeployConfig, (chain, config) => {
    const [remoteRouters, destinationGas] =
      getDefaultRemoteRouterAndDestinationGasConfig(
        multiProvider,
        chain,
        deployedRoutersAddresses,
        warpDeployConfig,
      );

    const chainConfig: WarpRouteDeployConfigMailboxRequired[string] = {
      // Default Expansion
      ...derivedTokenMetadata.getMetadataForChain(chain),
      remoteRouters,
      destinationGas,
      hook: zeroAddress,
      interchainSecurityModule: zeroAddress,
      proxyAdmin: isDeployedAsProxyByChain[chain]
        ? { owner: config.owner }
        : undefined,
      isNft: false,

      // User-specified config takes precedence
      ...config,
    };

    // Properly set the remote routers addresses to their 32 bytes representation
    // as that is how they are set on chain
    const formattedRemoteRouters = objMap(
      chainConfig.remoteRouters ?? {},
      (_domainId, { address }) => ({
        address: addressToBytes32(address),
      }),
    );

    chainConfig.remoteRouters = formattedRemoteRouters;

    return chainConfig;
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

/**
 * transforms the provided {@link HypTokenRouterConfig}, removing the address, totalSupply and ownerOverrides
 * field where they are not required for the config comparison
 */
export function transformConfigToCheck(
  obj: HypTokenRouterConfig,
): HypTokenRouterConfig {
  return sortArraysInConfig(
    transformObj(obj, transformWarpDeployConfigToCheck),
  );
}

/**
 * Splits warp deploy config into existing and extended configurations based on warp core chains
 * for the warp apply process.
 */
export function splitWarpCoreAndExtendedConfigs(
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
  warpCoreChains: string[],
): [
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigMailboxRequired,
] {
  return Object.entries(warpDeployConfig).reduce<
    [WarpRouteDeployConfigMailboxRequired, WarpRouteDeployConfigMailboxRequired]
  >(
    ([existing, extended], [chain, config]) => {
      if (warpCoreChains.includes(chain)) {
        existing[chain] = config;
      } else {
        extended[chain] = config;
      }
      return [existing, extended];
    },
    [{}, {}],
  );
}
