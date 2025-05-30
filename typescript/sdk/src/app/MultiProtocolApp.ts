import { PublicKey } from '@solana/web3.js';

import {
  Address,
  ProtocolType,
  objMap,
  promiseObjAll,
  rootLogger,
  symmetricDifference,
} from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import {
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  EthersV5Signer,
  SolanaWeb3Provider,
  SolanaWeb3Signer,
  StarknetJsProvider,
  TypedProvider,
} from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';
import { MultiGeneric } from '../utils/MultiGeneric.js';

/**
 * A minimal interface for an adapter that can be used with MultiProtocolApp
 * The purpose of adapters is to implement protocol-specific functionality
 * E.g. EvmRouterAdapter implements EVM-specific router functionality
 *   whereas SealevelRouterAdapter implements the same logic for Solana
 */
export abstract class BaseAppAdapter {
  public abstract readonly protocol: ProtocolType;
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: Record<string, Address>,
    public readonly logger = rootLogger.child({ module: `AppAdapter` }),
  ) {}
}

export type AdapterClassType<API> = new (
  chainName: ChainName,
  multiProvider: MultiProtocolProvider<any>,
  addresses: any,
  ...args: any
) => API;

export class BaseEvmAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Ethereum;

  public getProvider(): EthersV5Provider['provider'] {
    return this.multiProvider.getEthersV5Provider(this.chainName);
  }

  public getSigner(): EthersV5Signer['signer'] {
    return this.multiProvider.getEthersV5Signer(this.chainName);
  }
}

export class BaseCosmWasmAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Cosmos;

  public getProvider(): CosmJsWasmProvider['provider'] {
    return this.multiProvider.getCosmJsWasmProvider(this.chainName);
  }
}

export class BaseCosmosAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Cosmos;

  public getProvider(): CosmJsProvider['provider'] {
    return this.multiProvider.getCosmJsProvider(this.chainName);
  }
}

export class BaseCosmNativeAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.CosmosNative;

  public getProvider(): CosmJsNativeProvider['provider'] {
    return this.multiProvider.getCosmJsNativeProvider(this.chainName);
  }
}

export class BaseSealevelAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Sealevel;

  public getProvider(): SolanaWeb3Provider['provider'] {
    return this.multiProvider.getSolanaWeb3Provider(this.chainName);
  }

  public getSigner(): SolanaWeb3Signer['signer'] {
    return this.multiProvider.getSolanaWeb3Signer(this.chainName);
  }

  static derivePda(
    seeds: Array<string | Buffer>,
    programId: string | PublicKey,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      seeds.map((s) => Buffer.from(s)),
      new PublicKey(programId),
    );
    return pda;
  }

  // An dynamic alias for static method above for convenience
  derivePda(
    seeds: Array<string | Buffer>,
    programId: string | PublicKey,
  ): PublicKey {
    return BaseSealevelAdapter.derivePda(seeds, programId);
  }
}

export class BaseStarknetAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Starknet;

  public getProvider(): StarknetJsProvider['provider'] {
    return this.multiProvider.getStarknetProvider(this.chainName);
  }
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
 *
 * @override protocolToAdapter - This should return an Adapter class for a given protocol type
 */
export abstract class MultiProtocolApp<
  IAdapterApi extends BaseAppAdapter,
  ContractAddrs extends Record<string, Address> = {},
> extends MultiGeneric<ChainMetadata> {
  constructor(
    public readonly multiProvider: MultiProtocolProvider,
    public readonly addresses: ChainMap<ContractAddrs>,
    public readonly logger = rootLogger.child({ module: 'MultiProtocolApp' }),
  ) {
    const multiProviderChains = multiProvider.getKnownChainNames();
    const addressesChains = Object.keys(addresses);
    const setDifference = symmetricDifference(
      new Set(multiProviderChains),
      new Set(addressesChains),
    );
    if (setDifference.size > 0) {
      throw new Error(
        `MultiProtocolProvider and addresses must have the same chains. Provider chains: ${multiProviderChains.join(
          ', ',
        )}. Addresses chains: ${addressesChains.join(
          ', ',
        )}. Difference: ${Array.from(setDifference)}`,
      );
    }

    super(multiProvider.metadata);
  }

  // Subclasses must implement this with their specific adapters
  abstract protocolToAdapter(
    protocol: ProtocolType,
  ): AdapterClassType<IAdapterApi>;

  // Subclasses may want to override this to provide adapters more arguments
  adapter(chain: ChainName): IAdapterApi {
    const Adapter = this.protocolToAdapter(this.protocol(chain));
    return new Adapter(chain, this.multiProvider, this.addresses[chain]);
  }

  adapters(): ChainMap<IAdapterApi> {
    return this.map((chain, _) => this.adapter(chain));
  }

  adapterMap<Output>(
    fn: (n: ChainName, a: IAdapterApi) => Promise<Output>,
  ): Promise<ChainMap<Output>> {
    return promiseObjAll(objMap(this.adapters(), fn));
  }

  metadata(chain: ChainName): ChainMetadata {
    return this.get(chain);
  }

  protocol(chain: ChainName): ProtocolType {
    return this.metadata(chain).protocol;
  }

  provider(chain: ChainName): TypedProvider {
    return this.multiProvider.getProvider(chain);
  }
}
