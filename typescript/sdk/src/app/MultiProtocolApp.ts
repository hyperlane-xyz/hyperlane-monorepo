import { PublicKey } from '@solana/web3.js';
import debug from 'debug';

import {
  Address,
  ProtocolType,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import {
  EthersV5Provider,
  SolanaWeb3Provider,
  TypedProvider,
} from '../providers/ProviderType';
import { ChainMap, ChainName } from '../types';
import { MultiGeneric } from '../utils/MultiGeneric';

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
    public readonly logger = debug(`hyperlane:AppAdapter`),
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
}

export class BaseSealevelAdapter extends BaseAppAdapter {
  public readonly protocol: ProtocolType = ProtocolType.Sealevel;

  public getProvider(): SolanaWeb3Provider['provider'] {
    return this.multiProvider.getSolanaWeb3Provider(this.chainName);
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
    public readonly logger = debug('hyperlane:MultiProtocolApp'),
  ) {
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
