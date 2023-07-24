import debug from 'debug';

import { ProtocolType, objMap } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { ChainMap, ChainName } from '../types';
import { MultiGeneric } from '../utils/MultiGeneric';

/**
 * A minimal interface for an adapter that can be used with MultiProtocolApp
 * The purpose of adapters is to implement protocol-specific functionality
 * E.g. EvmRouterAdapter implements EVM-specific router functionality
 *   whereas SealevelRouterAdapter implements the same logic for Solana
 */
export abstract class BaseAppAdapter<ContractAddrs = {}> {
  public abstract readonly protocol: ProtocolType;
  constructor(
    public readonly multiProvider: MultiProtocolProvider<ContractAddrs>,
  ) {}
}

export type AdapterClassType<ContractAddrs = {}, API = {}> = new (
  multiProvider: MultiProtocolProvider<ContractAddrs>,
) => API;

export class BaseEvmAdapter<
  ContractAddrs = {},
> extends BaseAppAdapter<ContractAddrs> {
  public readonly protocol: ProtocolType = ProtocolType.Ethereum;
}

export class BaseSealevelAdapter<
  ContractAddrs = {},
> extends BaseAppAdapter<ContractAddrs> {
  public readonly protocol: ProtocolType = ProtocolType.Sealevel;
}

/**
 * A version of HyperlaneApp that can support different
 * provider types across different protocol types.
 *
 * Intentionally minimal as it's meant to be extended.
 * Extend this class as needed to add useful methods/properties.
 *
 * @typeParam ContractAddrs - A map of contract names to addresses
 * @typeParam IAdapterApi - The type of the adapters for implementing the app's
 *   functionality across different protocols.
 *
 * @param multiProvider - A MultiProtocolProvider instance that MUST include the app's
 *   contract addresses in its chain metadata
 * @param logger - A logger instance
 */
export abstract class MultiProtocolApp<
  ContractAddrs = {},
  IAdapterApi extends BaseAppAdapter = BaseAppAdapter,
> extends MultiGeneric<IAdapterApi> {
  public abstract readonly adapters: Partial<
    Record<ProtocolType, AdapterClassType<ContractAddrs, IAdapterApi>>
  >;

  constructor(
    public readonly multiProvider: MultiProtocolProvider<ContractAddrs>,
    public readonly logger = debug('hyperlane:MultiProtocolApp'),
  ) {
    const chainToAdapter: ChainMap<IAdapterApi> = objMap(
      multiProvider.metadata,
      (_, metadata) => {
        const Adapter = this.adapters[metadata.protocol];
        if (!Adapter)
          throw new Error(`No adapter for protocol ${metadata.protocol}`);
        return new Adapter(multiProvider);
      },
    );
    super(chainToAdapter);
  }

  adapter(chain: ChainName): IAdapterApi {
    return this.get(chain);
  }

  metadata(chain: ChainName): ChainMetadata<ContractAddrs> {
    return this.multiProvider.getChainMetadata(chain);
  }
}
