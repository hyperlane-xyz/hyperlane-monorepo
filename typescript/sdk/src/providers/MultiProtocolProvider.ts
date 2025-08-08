import { Logger } from 'pino';

import {
  Address,
  HexString,
  ProtocolType,
  objFilter,
  objMap,
  pick,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { multiProtocolTestChainMetadata } from '../consts/testChains.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import { MultiProvider, MultiProviderOptions } from './MultiProvider.js';
import {
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  EthersV5Signer,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProviderMap,
  ProviderType,
  SolanaWeb3Provider,
  SolanaWeb3Signer,
  StarknetJsProvider,
  TypedProvider,
  TypedSigner,
  TypedTransaction,
  ViemProvider,
} from './ProviderType.js';
import {
  ProviderBuilderMap,
  defaultProviderBuilderMap,
} from './providerBuilders.js';
import {
  TransactionFeeEstimate,
  estimateTransactionFee,
} from './transactionFeeEstimators.js';

export interface MultiProtocolProviderOptions {
  logger?: Logger;
  providers?: ChainMap<ProviderMap<TypedProvider>>;
  signers?: ChainMap<ProviderMap<TypedSigner>>;
  providerBuilders?: Partial<ProviderBuilderMap>;
}

/**
 * A version of MultiProvider that can support different
 * provider types across different protocol types.
 *
 * This uses a different interface for provider/signer related methods
 * so it isn't strictly backwards compatible with MultiProvider.
 *
 * Unlike MultiProvider, this class does not support signer/signing methods (yet).
 * @typeParam MetaExt - Extra metadata fields for chains (such as contract addresses)
 */
export class MultiProtocolProvider<
  MetaExt = {},
> extends ChainMetadataManager<MetaExt> {
  // Chain name -> provider type -> provider
  protected readonly providers: ChainMap<ProviderMap<TypedProvider>>;
  // Chain name -> provider type -> signer
  protected signers: ChainMap<ProviderMap<TypedSigner>>;
  protected readonly providerBuilders: Partial<ProviderBuilderMap>;
  public readonly logger: Logger;

  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: MultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, options);
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: 'MultiProtocolProvider',
      });
    this.providers = options.providers || {};
    this.signers = options.signers || {};
    this.providerBuilders =
      options.providerBuilders || defaultProviderBuilderMap;
  }

  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: MultiProtocolProviderOptions = {},
  ): MultiProtocolProvider<MetaExt> {
    const newMp = new MultiProtocolProvider<MetaExt>(mp.metadata, options);

    const typedProviders = objMap(mp.providers, (_, provider) => ({
      type: ProviderType.EthersV5,
      provider,
    })) as ChainMap<TypedProvider>;

    newMp.setProviders(typedProviders);
    return newMp;
  }

  toMultiProvider(options?: MultiProviderOptions): MultiProvider<MetaExt> {
    const newMp = new MultiProvider<MetaExt>(this.metadata, options);

    const providers = objMap(
      this.providers,
      (_, typeToProviders) => typeToProviders[ProviderType.EthersV5]?.provider,
    ) as ChainMap<EthersV5Provider['provider'] | undefined>;

    const filteredProviders = objFilter(
      providers,
      (_, p): p is EthersV5Provider['provider'] => !!p,
    ) as ChainMap<EthersV5Provider['provider']>;

    newMp.setProviders(filteredProviders);
    return newMp;
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProtocolProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    const newMp = new MultiProtocolProvider(newMetadata, {
      ...this.options,
      providers: this.providers,
    });
    return newMp;
  }

  tryGetProvider(
    chainNameOrId: ChainNameOrId,
    type?: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { protocol, name, chainId, rpcUrls } = metadata;
    type = type || PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol];
    if (!type) return null;

    if (this.providers[name]?.[type]) return this.providers[name][type]!;

    const builder = this.providerBuilders[type];
    if (!rpcUrls.length || !builder) return null;

    const provider = builder(rpcUrls, chainId);
    this.providers[name] ||= {};
    this.providers[name][type] = provider;
    return provider;
  }

  getProvider(
    chainNameOrId: ChainNameOrId,
    type?: ProviderType,
  ): TypedProvider {
    const provider = this.tryGetProvider(chainNameOrId, type);
    if (!provider)
      throw new Error(`No provider available for ${chainNameOrId}`);
    return provider;
  }

  protected getSpecificProvider<T>(
    chainNameOrId: ChainNameOrId,
    type: ProviderType,
  ): T {
    const provider = this.getProvider(chainNameOrId, type);
    if (provider.type !== type)
      throw new Error(
        `Invalid provider type, expected ${type} but found ${provider.type}`,
      );
    return provider.provider as T;
  }

  getEthersV5Provider(
    chainNameOrId: ChainNameOrId,
  ): EthersV5Provider['provider'] {
    return this.getSpecificProvider<EthersV5Provider['provider']>(
      chainNameOrId,
      ProviderType.EthersV5,
    );
  }

  getViemProvider(chainNameOrId: ChainNameOrId): ViemProvider['provider'] {
    return this.getSpecificProvider<ViemProvider['provider']>(
      chainNameOrId,
      ProviderType.Viem,
    );
  }

  getSolanaWeb3Provider(
    chainNameOrId: ChainNameOrId,
  ): SolanaWeb3Provider['provider'] {
    return this.getSpecificProvider<SolanaWeb3Provider['provider']>(
      chainNameOrId,
      ProviderType.SolanaWeb3,
    );
  }

  getCosmJsProvider(chainNameOrId: ChainNameOrId): CosmJsProvider['provider'] {
    return this.getSpecificProvider<CosmJsProvider['provider']>(
      chainNameOrId,
      ProviderType.CosmJs,
    );
  }

  getCosmJsWasmProvider(
    chainNameOrId: ChainNameOrId,
  ): CosmJsWasmProvider['provider'] {
    return this.getSpecificProvider<CosmJsWasmProvider['provider']>(
      chainNameOrId,
      ProviderType.CosmJsWasm,
    );
  }

  getCosmJsNativeProvider(
    chainNameOrId: ChainNameOrId,
  ): CosmJsNativeProvider['provider'] {
    return this.getSpecificProvider<CosmJsNativeProvider['provider']>(
      chainNameOrId,
      ProviderType.CosmJsNative,
    );
  }

  getStarknetProvider(
    chainNameOrId: ChainNameOrId,
  ): StarknetJsProvider['provider'] {
    return this.getSpecificProvider<StarknetJsProvider['provider']>(
      chainNameOrId,
      ProviderType.Starknet,
    );
  }

  setProvider(
    chainNameOrId: ChainNameOrId,
    provider: TypedProvider,
  ): TypedProvider {
    const chainName = this.getChainName(chainNameOrId);
    this.providers[chainName] ||= {};
    this.providers[chainName][provider.type] = provider;
    return provider;
  }

  setProviders(providers: ChainMap<TypedProvider>): void {
    for (const chain of Object.keys(providers)) {
      this.setProvider(chain, providers[chain]);
    }
  }

  tryGetSigner(
    chainNameOrId: ChainNameOrId,
    type?: ProviderType,
  ): TypedSigner | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { name, protocol } = metadata;
    type = type || PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol];
    if (!type) return null;
    return this.signers[name]?.[type] || null;
  }

  getSigner(chainNameOrId: ChainNameOrId, type?: ProviderType): TypedSigner {
    const signer = this.tryGetSigner(chainNameOrId, type);
    if (!signer) throw new Error(`No signer available for ${chainNameOrId}`);
    return signer;
  }

  protected getSpecificSigner<T>(
    chainNameOrId: ChainNameOrId,
    type: ProviderType,
  ): T {
    const signer = this.getSigner(chainNameOrId, type);
    return signer.signer as T;
  }

  getSolanaWeb3Signer(
    chainNameOrId: ChainNameOrId,
  ): SolanaWeb3Signer['signer'] {
    return this.getSpecificSigner<SolanaWeb3Signer['signer']>(
      chainNameOrId,
      ProviderType.SolanaWeb3,
    );
  }

  getEthersV5Signer(chainNameOrId: ChainNameOrId): EthersV5Signer['signer'] {
    return this.getSpecificSigner<EthersV5Signer['signer']>(
      chainNameOrId,
      ProviderType.EthersV5,
    );
  }

  setSigner(chainNameOrId: ChainNameOrId, signer: TypedSigner): TypedSigner {
    const chainName = this.getChainName(chainNameOrId);
    this.signers[chainName] ||= {};
    this.signers[chainName][signer.type] = signer;
    return signer;
  }

  estimateTransactionFee({
    chainNameOrId,
    transaction,
    sender,
    senderPubKey,
  }: {
    chainNameOrId: ChainNameOrId;
    transaction: TypedTransaction;
    sender: Address;
    senderPubKey?: HexString;
  }): Promise<TransactionFeeEstimate> {
    const provider = this.getProvider(chainNameOrId, transaction.type);
    const chainMetadata = this.getChainMetadata(chainNameOrId);
    return estimateTransactionFee({
      transaction,
      provider,
      chainMetadata,
      sender,
      senderPubKey,
    });
  }

  override intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    result: MultiProtocolProvider<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    const multiProvider = new MultiProtocolProvider(result.metadata, {
      ...this.options,
      providers: pick(this.providers, intersection),
    });
    return { intersection, result: multiProvider };
  }

  /**
   * Creates a MultiProvider for test networks
   */
  static createTestMultiProtocolProvider<MetaExt = {}>(
    metadata = multiProtocolTestChainMetadata,
    providers: Partial<Record<ProtocolType, TypedProvider>> = {},
  ): MultiProtocolProvider<MetaExt> {
    const mp = new MultiProtocolProvider(metadata);
    const providerMap: ChainMap<TypedProvider> = {};
    for (const [protocol, provider] of Object.entries(providers)) {
      const chains = Object.values(metadata).filter(
        (m) => m.protocol === protocol,
      );
      chains.forEach((c) => (providerMap[c.name] = provider));
    }
    mp.setProviders(providerMap);
    return mp as MultiProtocolProvider<MetaExt>;
  }
}
