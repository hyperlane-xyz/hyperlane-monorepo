import { Debugger, debug } from 'debug';

import { ProtocolType, objFilter, objMap, pick } from '@hyperlane-xyz/utils';

import { chainMetadata as defaultChainMetadata } from '../consts/chainMetadata';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager';
import type { ChainMetadata } from '../metadata/chainMetadataTypes';
import type { ChainMap, ChainName } from '../types';

import { MultiProvider, MultiProviderOptions } from './MultiProvider';
import {
  EthersV5Provider,
  ProviderMap,
  ProviderType,
  SolanaWeb3Provider,
  TypedProvider,
  ViemProvider,
} from './ProviderType';
import {
  ProviderBuilderMap,
  defaultProviderBuilderMap,
} from './providerBuilders';

export const PROTOCOL_DEFAULT_PROVIDER_TYPE: Partial<
  Record<ProtocolType, ProviderType>
> = {
  [ProtocolType.Ethereum]: ProviderType.EthersV5,
  [ProtocolType.Sealevel]: ProviderType.SolanaWeb3,
};

export interface MultiProtocolProviderOptions {
  loggerName?: string;
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
  public readonly logger: Debugger;

  constructor(
    chainMetadata: ChainMap<
      ChainMetadata<MetaExt>
    > = defaultChainMetadata as ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: MultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, options);
    this.logger = debug(
      options?.loggerName || 'hyperlane:MultiProtocolProvider',
    );
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
    chainNameOrId: ChainName | number,
    type?: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { protocol, name, chainId, rpcUrls } = metadata;
    type = type || PROTOCOL_DEFAULT_PROVIDER_TYPE[protocol];
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
    chainNameOrId: ChainName | number,
    type?: ProviderType,
  ): TypedProvider {
    const provider = this.tryGetProvider(chainNameOrId, type);
    if (!provider)
      throw new Error(`No provider available for ${chainNameOrId}`);
    return provider;
  }

  getEthersV5Provider(
    chainNameOrId: ChainName | number,
  ): EthersV5Provider['provider'] {
    const provider = this.getProvider(chainNameOrId, ProviderType.EthersV5);
    if (provider.type !== ProviderType.EthersV5)
      throw new Error('Invalid provider type');
    return provider.provider;
  }

  // getEthersV6Provider(
  //   chainNameOrId: ChainName | number,
  // ): EthersV6Provider['provider'] {
  //   const provider = this.getProvider(chainNameOrId, ProviderType.EthersV6);
  //   if (provider.type !== ProviderType.EthersV6)
  //     throw new Error('Invalid provider type');
  //   return provider.provider;
  // }

  getViemProvider(chainNameOrId: ChainName | number): ViemProvider['provider'] {
    const provider = this.getProvider(chainNameOrId, ProviderType.Viem);
    if (provider.type !== ProviderType.Viem)
      throw new Error('Invalid provider type');
    return provider.provider;
  }

  getSolanaWeb3Provider(
    chainNameOrId: ChainName | number,
  ): SolanaWeb3Provider['provider'] {
    const provider = this.getProvider(chainNameOrId, ProviderType.SolanaWeb3);
    if (provider.type !== ProviderType.SolanaWeb3)
      throw new Error('Invalid provider type');
    return provider.provider;
  }

  setProvider(
    chainNameOrId: ChainName | number,
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
}
