import { Logger } from 'pino';

import {
  Address,
  HexString,
  ProtocolType,
  pick,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName, ChainNameOrId } from '../types.js';

import {
  AleoProvider,
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  PROTOCOL_TO_DEFAULT_PROVIDER_TYPE,
  ProviderMap,
  ProviderType,
  RadixProvider,
  SolanaWeb3Provider,
  StarknetJsProvider,
  TronProvider,
  TypedProvider,
  TypedTransaction,
  ViemProvider,
} from './ProviderType.js';
import type {
  ProviderBuilderFn,
  ProviderBuilderMap,
} from './providerBuilders.js';
import {
  TransactionFeeEstimate,
  estimateTransactionFee,
} from './transactionFeeEstimators.js';

export interface MinimalProviderRegistryOptions {
  logger?: Logger;
  providers?: ChainMap<ProviderMap<TypedProvider>>;
  providerBuilders?: Partial<ProviderBuilderMap>;
}

export class MinimalProviderRegistry<
  MetaExt = {},
> extends ChainMetadataManager<MetaExt> {
  protected readonly providers: ChainMap<ProviderMap<TypedProvider>>;
  protected readonly providerBuilders: Partial<ProviderBuilderMap>;
  public readonly logger: Logger;

  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: MinimalProviderRegistryOptions = {},
  ) {
    super(chainMetadata, options);
    const loggerModule = new.target?.name || 'MinimalProviderRegistry';
    this.logger =
      options.logger ||
      rootLogger.child({
        module: loggerModule,
      });
    this.providers = options.providers || {};
    this.providerBuilders = options.providerBuilders || {};
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MinimalProviderRegistry<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MinimalProviderRegistry(newMetadata, {
      ...this.options,
      providers: this.providers,
      providerBuilders: this.providerBuilders,
    });
  }

  protected getProviderBuilder(
    _protocol: ProtocolType,
    type: ProviderType,
  ): ProviderBuilderFn<TypedProvider> | undefined {
    return this.providerBuilders[type];
  }

  tryGetProvider(
    chainNameOrId: ChainNameOrId,
    type?: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { protocol, name, chainId, rpcUrls } = metadata;
    if (protocol === ProtocolType.Unknown) return null;
    type = type || PROTOCOL_TO_DEFAULT_PROVIDER_TYPE[protocol];
    if (!type) return null;

    if (this.providers[name]?.[type]) return this.providers[name][type]!;

    const builder = this.getProviderBuilder(protocol, type);
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

  getRadixProvider(chainNameOrId: ChainNameOrId): RadixProvider['provider'] {
    return this.getSpecificProvider<RadixProvider['provider']>(
      chainNameOrId,
      ProviderType.Radix,
    );
  }

  getAleoProvider(chainNameOrId: ChainNameOrId): AleoProvider['provider'] {
    return this.getSpecificProvider<AleoProvider['provider']>(
      chainNameOrId,
      ProviderType.Aleo,
    );
  }

  getTronProvider(chainNameOrId: ChainNameOrId): TronProvider['provider'] {
    return this.getSpecificProvider<TronProvider['provider']>(
      chainNameOrId,
      ProviderType.Tron,
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
    result: MinimalProviderRegistry<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    return {
      intersection,
      result: new MinimalProviderRegistry(result.metadata, {
        ...this.options,
        providers: pick(this.providers, intersection),
        providerBuilders: this.providerBuilders,
      }),
    };
  }
}
