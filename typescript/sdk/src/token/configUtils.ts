import { zeroAddress } from 'viem';

import {
  Address,
  ProtocolType,
  TransformObjectTransformer,
  addressToBytes32,
  intersection,
  isAddressEvm,
  isCosmosIbcDenomAddress,
  objFilter,
  objMap,
  promiseObjAll,
  sortArraysInObject,
  transformObj,
} from '@hyperlane-xyz/utils';

import { isProxy } from '../deploy/proxy.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { DestinationGas, RemoteRouters } from '../router/types.js';
import { ChainMap } from '../types.js';
import { WarpCoreConfig } from '../warp/types.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { TokenMetadataMap } from './TokenMetadataMap.js';
import { gasOverhead } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import {
  ContractVerificationStatus,
  DerivedWarpRouteDeployConfig,
  HypTokenRouterConfig,
  HypTokenRouterVirtualConfig,
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
    warpCoreConfig.tokens
      // Removing IBC denom addresses because they are on the same
      // chain as the actual warp token but they are only used
      // used to pay the IGP hook
      .filter(
        (token) =>
          token.addressOrDenom &&
          !isCosmosIbcDenomAddress(token.addressOrDenom),
      )
      .map((token) => [token.chainName, token.addressOrDenom]),
  ) as ChainMap<Address>;
}

/**
 * Expands a Warp deploy config with additional data
 *
 * @param multiProvider
 * @param warpDeployConfig - The warp deployment config
 * @param deployedRoutersAddresses - Addresses of deployed routers for each chain
 * @param virtualConfig - Optional virtual config to include in the warpDeployConfig
 * @returns A promise resolving to an expanded Warp deploy config with derived and virtual metadata
 */
export async function expandWarpDeployConfig(params: {
  multiProvider: MultiProvider;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  deployedRoutersAddresses: ChainMap<Address>;
  expandedOnChainWarpConfig?: WarpRouteDeployConfigMailboxRequired;
}): Promise<WarpRouteDeployConfigMailboxRequired> {
  const {
    multiProvider,
    warpDeployConfig,
    deployedRoutersAddresses,
    expandedOnChainWarpConfig,
  } = params;

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

  return promiseObjAll(
    objMap(warpDeployConfig, async (chain, config) => {
      const [remoteRouters, destinationGas] =
        getDefaultRemoteRouterAndDestinationGasConfig(
          multiProvider,
          chain,
          deployedRoutersAddresses,
          warpDeployConfig,
        );

      const chainConfig: WarpRouteDeployConfigMailboxRequired[string] &
        Partial<HypTokenRouterVirtualConfig> = {
        // Default Expansion
        name: derivedTokenMetadata.getName(chain),
        symbol: derivedTokenMetadata.getSymbol(chain),
        decimals: derivedTokenMetadata.getDecimals(chain),
        scale: derivedTokenMetadata.getScale(chain),
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

      const remoteGasDomainsToKeep = intersection(
        new Set(Object.keys(chainConfig.destinationGas ?? {})),
        new Set(Object.keys(formattedRemoteRouters)),
      );

      // If the deploy config specified a custom config for remote routers
      // we should not have all the gas settings set
      const formattedDestinationGas = objFilter(
        chainConfig.destinationGas ?? {},
        (domainId, _gasSetting): _gasSetting is string =>
          remoteGasDomainsToKeep.has(domainId),
      );

      chainConfig.destinationGas = formattedDestinationGas;

      const isEVMChain =
        multiProvider.getProtocol(chain) === ProtocolType.Ethereum;

      // Expand EVM warpDeployConfig virtual to the control states
      if (
        expandedOnChainWarpConfig?.[chain]?.contractVerificationStatus &&
        multiProvider.getProtocol(chain) === ProtocolType.Ethereum
      ) {
        // For most cases, we set to Verified
        chainConfig.contractVerificationStatus = objMap(
          expandedOnChainWarpConfig[chain].contractVerificationStatus ?? {},
          (_, status) => {
            // Skipped for local e2e testing
            if (status === ContractVerificationStatus.Skipped)
              return ContractVerificationStatus.Skipped;

            return ContractVerificationStatus.Verified;
          },
        );
      }

      // Expand the hook config only if we have an explicit config in the deploy config
      // and the current chain is an EVM one.
      // if we have an address we leave it like that to avoid deriving
      if (
        isEVMChain &&
        chainConfig.hook &&
        typeof chainConfig.hook !== 'string'
      ) {
        const reader = new EvmHookReader(multiProvider, chain);

        chainConfig.hook = await reader.deriveHookConfig(chainConfig.hook);
      }

      // Expand the ism config only if we have an explicit config in the deploy config
      // if we have an address we leave it like that to avoid deriving
      if (
        isEVMChain &&
        chainConfig.interchainSecurityModule &&
        typeof chainConfig.interchainSecurityModule !== 'string'
      ) {
        const reader = new EvmIsmReader(multiProvider, chain);

        chainConfig.interchainSecurityModule = await reader.deriveIsmConfig(
          chainConfig.interchainSecurityModule,
        );
      }

      return chainConfig;
    }),
  );
}

export async function expandVirtualWarpDeployConfig(params: {
  multiProvider: MultiProvider;
  onChainWarpConfig: DerivedWarpRouteDeployConfig;
  deployedRoutersAddresses: ChainMap<Address>;
}): Promise<
  DerivedWarpRouteDeployConfig &
    Record<string, Partial<HypTokenRouterVirtualConfig>>
> {
  const { multiProvider, onChainWarpConfig, deployedRoutersAddresses } = params;
  return promiseObjAll(
    objMap(onChainWarpConfig, async (chain, config) => {
      const warpReader = new EvmERC20WarpRouteReader(multiProvider, chain);
      const warpVirtualConfig = await warpReader.deriveWarpRouteVirtualConfig(
        chain,
        deployedRoutersAddresses[chain],
      );
      return {
        ...warpVirtualConfig,
        ...config,
        hook: config.hook ?? zeroAddress,
      };
    }),
  );
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

  if (typeof obj === 'string' && parentKey !== 'type' && isAddressEvm(obj)) {
    return obj.toLowerCase();
  }

  return obj;
};

const sortArraysInConfigToCheck = (a: any, b: any): number => {
  if (a.type && b.type) {
    if (a.type < b.type) return -1;
    if (a.type > b.type) return 1;
    return 0;
  }

  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
};

const FIELDS_TO_IGNORE = new Set<keyof HypTokenRouterConfig>([
  // gas is removed because the destinationGas is the result of
  // expanding the config based on the gas value for each chain
  // see `expandWarpDeployConfig` function
  'gas',
  // Removing symbol and token metadata as they are not critical for
  // checking, even if they are set "incorrectly" they do not affect how
  // the warp route works
  'symbol',
  'name',
]);

/**
 * transforms the provided {@link HypTokenRouterConfig}, removing the address, totalSupply and ownerOverrides
 * field where they are not required for the config comparison
 */
export function transformConfigToCheck(
  obj: HypTokenRouterConfig,
): HypTokenRouterConfig {
  const filteredObj = Object.fromEntries(
    Object.entries(obj).filter(
      ([key, _value]) =>
        !FIELDS_TO_IGNORE.has(key as keyof HypTokenRouterConfig),
    ),
  );

  return sortArraysInObject(
    transformObj(filteredObj, transformWarpDeployConfigToCheck),
    sortArraysInConfigToCheck,
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
