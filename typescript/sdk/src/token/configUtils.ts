import { zeroAddress } from 'viem';

import { Address, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { DestinationGas, RemoteRouters } from '../router/types.js';
import { ChainMap } from '../types.js';
import { WarpCoreConfig } from '../warp/types.js';

import { gasOverhead } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { WarpRouteDeployConfig } from './types.js';

/**
 * Gets router address for a chain
 */
const getRemoteRouterAddress = (
  deployedRoutersAddresses: ChainMap<Address>,
  chain: string,
): Address => deployedRoutersAddresses[chain];

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
      address: getRemoteRouterAddress(deployedRoutersAddresses, otherChain),
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
  return promiseObjAll(
    objMap(warpDeployConfig, async (chain, config) => {
      const [remoteRouters, destinationGas] =
        getDefaultRemoteRouterAndDestinationGasConfig(
          multiProvider,
          chain,
          deployedRoutersAddresses,
          warpDeployConfig,
        );

      return {
        ...derivedTokenMetadata,
        remoteRouters,
        destinationGas,
        hook: zeroAddress,
        interchainSecurityModule: zeroAddress,
        proxyAdmin: { owner: config.owner },
        ...config,
      };
    }),
  );
}
