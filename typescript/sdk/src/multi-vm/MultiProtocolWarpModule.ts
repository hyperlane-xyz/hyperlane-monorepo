import {
  Address,
  ObjectDiff,
  ProtocolType,
  diffObjMerge,
  objFilter,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmERC20WarpRouteReader } from '../token/EvmERC20WarpRouteReader.js';
import { IWarpRouteReader } from '../token/IWarpReader.js';
import {
  expandWarpDeployConfig,
  getRouterAddressesFromWarpCoreConfig,
  transformConfigToCheck,
} from '../token/configUtils.js';
import {
  DerivedTokenRouterConfig,
  DerivedWarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
} from '../token/types.js';
import { ChainMap, ChainName } from '../types.js';
import { WarpCoreConfig } from '../warp/types.js';

const supportedProtocols: Readonly<Record<ProtocolType, boolean>> = {
  [ProtocolType.Cosmos]: false,
  [ProtocolType.CosmosNative]: false,
  [ProtocolType.Ethereum]: true,
  [ProtocolType.Sealevel]: false,
  [ProtocolType.Starknet]: false,
};

type WarpRouteReaderFactory<TProtocol extends ProtocolType> = (
  chain: ChainName,
  multiProvider: MultiProvider,
) => Promise<IWarpRouteReader<TProtocol>>;

type WarpRouteReaderFactoriesByProtocolType = {
  [Key in ProtocolType]: WarpRouteReaderFactory<Key>;
};

const warpRouteReaderFactories: Partial<WarpRouteReaderFactoriesByProtocolType> =
  {
    [ProtocolType.Ethereum]: async (
      chain: ChainName,
      multiProvider: MultiProvider,
    ) => new EvmERC20WarpRouteReader(multiProvider, chain),
  };

export class MultiProtocolWarpRouteModule<TConfig> {
  protected constructor(
    protected readonly config: TConfig,
    protected readonly multiProvider: MultiProvider,
  ) {}

  static async fromDeployedConfig(
    multiProvider: MultiProvider,
    warpDeployConfig: WarpRouteDeployConfigMailboxRequired,
    warpCoreConfig: WarpCoreConfig,
  ): Promise<IDeployedMultiProtocolWarpRouteModule> {
    // Create the readers before expanding the deploy config so that if read is called
    // on the class instance, the hook config might be already cached avoiding re-deriving
    // the config
    const readersByChain: Partial<ChainMap<IWarpRouteReader<ProtocolType>>> =
      await promiseObjAll(
        objMap(
          warpDeployConfig,
          async (
            chain,
            _config,
          ): Promise<IWarpRouteReader<ProtocolType> | undefined> => {
            const protocol = multiProvider.getProtocol(chain);
            if (!supportedProtocols[protocol]) {
              return undefined;
            }

            if (!warpRouteReaderFactories[protocol]) {
              return undefined;
            }

            return warpRouteReaderFactories[protocol]!(chain, multiProvider);
          },
        ),
      );

    // Expand the config before removing unsupported chain configs to correctly expand
    // the remote routers mapping
    let expandedWarpDeployConfig = await expandWarpDeployConfig(
      multiProvider,
      warpDeployConfig,
      getRouterAddressesFromWarpCoreConfig(warpCoreConfig),
      readersByChain,
    );

    // Remove any  unsupported protocols to avoid the
    // underlying code crashing
    warpCoreConfig.tokens = warpCoreConfig.tokens.filter(
      (config) =>
        supportedProtocols[multiProvider.getProtocol(config.chainName)],
    );

    const supportedRouterAddressesByChain =
      getRouterAddressesFromWarpCoreConfig(warpCoreConfig);

    expandedWarpDeployConfig = objFilter(
      expandedWarpDeployConfig,
      (chain, _config): _config is any =>
        supportedProtocols[multiProvider.getProtocol(chain)],
    );

    return new DeployedMultiProtocolWarpRouteModule(
      expandedWarpDeployConfig,
      supportedRouterAddressesByChain,
      multiProvider,
      readersByChain,
    );
  }
}

export type CheckDeployedWarpRouteResult =
  | { isInvalid: false }
  | { isInvalid: true; violations: ChainMap<any> };

export interface IDeployedMultiProtocolWarpRouteModule {
  read(): Promise<DerivedWarpRouteDeployConfig>;

  check(): Promise<CheckDeployedWarpRouteResult>;
}

class DeployedMultiProtocolWarpRouteModule
  extends MultiProtocolWarpRouteModule<WarpRouteDeployConfigMailboxRequired>
  implements IDeployedMultiProtocolWarpRouteModule
{
  constructor(
    config: WarpRouteDeployConfigMailboxRequired,
    private deployedAddressesByChain: ChainMap<Address>,
    multiProvider: MultiProvider,
    private readonly readersByChain: Partial<
      ChainMap<IWarpRouteReader<ProtocolType>>
    >,
    private readonly logger = rootLogger.child({
      module: DeployedMultiProtocolWarpRouteModule.name,
    }),
  ) {
    super(config, multiProvider);
  }

  public async read(): Promise<DerivedWarpRouteDeployConfig> {
    return promiseObjAll(
      objFilter(
        objMap(this.deployedAddressesByChain, async (chain, address) =>
          this.readersByChain[chain]?.deriveWarpRouteConfig(address),
        ),
        (
          _chain,
          maybeDerivationPromise,
        ): maybeDerivationPromise is Promise<
          DerivedTokenRouterConfig | undefined
        > => !!maybeDerivationPromise,
      ),
    ) as Promise<DerivedWarpRouteDeployConfig>;
  }

  public async check(): Promise<CheckDeployedWarpRouteResult> {
    const currentConfig = await this.read();

    // Go through each chain and only add to the output the chains that have mismatches
    const [violations, isInvalid] = Object.entries(this.config).reduce(
      (acc, [chain, config]) => {
        this.logger.debug(`Checking configuration on chain "${chain}"`);
        const expectedDeployedConfig = config;
        const currentDeployedConfig = currentConfig[chain];

        // If the expected config specifies the hook or the ism as an address instead of the full config
        // compare just the addresses
        if (typeof expectedDeployedConfig.hook === 'string') {
          currentDeployedConfig.hook = derivedHookAddress(
            currentDeployedConfig,
          );
        }

        if (
          typeof expectedDeployedConfig.interchainSecurityModule === 'string'
        ) {
          currentDeployedConfig.interchainSecurityModule = derivedIsmAddress(
            currentDeployedConfig,
          );
        }

        const { mergedObject, isInvalid } = diffObjMerge(
          transformConfigToCheck(currentDeployedConfig),
          transformConfigToCheck(expectedDeployedConfig),
        );

        if (isInvalid) {
          acc[0][chain] = mergedObject;
          acc[1] ||= isInvalid;
        }

        return acc;
      },
      [{}, false] as [{ [index: string]: ObjectDiff }, boolean],
    );

    if (isInvalid) {
      return {
        isInvalid,
        violations,
      };
    }

    return {
      isInvalid: false,
    };
  }
}
