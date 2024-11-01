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
import type { ChainMap, ChainName, ChainNameOrDomain } from '../types.js';

import { MultiProvider, MultiProviderOptions } from './MultiProvider.js';
import {
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProviderMap,
  ProviderType,
  SolanaWeb3Provider,
  TypedProvider,
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
  protected signers: ChainMap<ProviderMap<never>> = {}; // TODO signer support
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
    ChainNameOrDomain: ChainNameOrDomain,
    type?: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(ChainNameOrDomain);
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
    ChainNameOrDomain: ChainNameOrDomain,
    type?: ProviderType,
  ): TypedProvider {
    const provider = this.tryGetProvider(ChainNameOrDomain, type);
    if (!provider)
      throw new Error(`No provider available for ${ChainNameOrDomain}`);
    return provider;
  }

  protected getSpecificProvider<T>(
    ChainNameOrDomain: ChainNameOrDomain,
    type: ProviderType,
  ): T {
    const provider = this.getProvider(ChainNameOrDomain, type);
    if (provider.type !== type)
      throw new Error(
        `Invalid provider type, expected ${type} but found ${provider.type}`,
      );
    return provider.provider as T;
  }

  getEthersV5Provider(
    ChainNameOrDomain: ChainNameOrDomain,
  ): EthersV5Provider['provider'] {
    return this.getSpecificProvider<EthersV5Provider['provider']>(
      ChainNameOrDomain,
      ProviderType.EthersV5,
    );
  }

  getViemProvider(
    ChainNameOrDomain: ChainNameOrDomain,
  ): ViemProvider['provider'] {
    return this.getSpecificProvider<ViemProvider['provider']>(
      ChainNameOrDomain,
      ProviderType.Viem,
    );
  }

  getSolanaWeb3Provider(
    ChainNameOrDomain: ChainNameOrDomain,
  ): SolanaWeb3Provider['provider'] {
    return this.getSpecificProvider<SolanaWeb3Provider['provider']>(
      ChainNameOrDomain,
      ProviderType.SolanaWeb3,
    );
  }

  getCosmJsProvider(
    ChainNameOrDomain: ChainNameOrDomain,
  ): CosmJsProvider['provider'] {
    return this.getSpecificProvider<CosmJsProvider['provider']>(
      ChainNameOrDomain,
      ProviderType.CosmJs,
    );
  }

  getCosmJsWasmProvider(
    ChainNameOrDomain: ChainNameOrDomain,
  ): CosmJsWasmProvider['provider'] {
    return this.getSpecificProvider<CosmJsWasmProvider['provider']>(
      ChainNameOrDomain,
      ProviderType.CosmJsWasm,
    );
  }

  setProvider(
    ChainNameOrDomain: ChainNameOrDomain,
    provider: TypedProvider,
  ): TypedProvider {
    const chainName = this.getChainName(ChainNameOrDomain);
    this.providers[chainName] ||= {};
    this.providers[chainName][provider.type] = provider;
    return provider;
  }

  setProviders(providers: ChainMap<TypedProvider>): void {
    for (const chain of Object.keys(providers)) {
      this.setProvider(chain, providers[chain]);
    }
  }

  estimateTransactionFee({
    chainNameOrDomain,
    transaction,
    sender,
    senderPubKey,
  }: {
    chainNameOrDomain: ChainNameOrDomain;
    transaction: TypedTransaction;
    sender: Address;
    senderPubKey?: HexString;
  }): Promise<TransactionFeeEstimate> {
    const provider = this.getProvider(chainNameOrDomain, transaction.type);
    const chainMetadata = this.getChainMetadata(chainNameOrDomain);
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
