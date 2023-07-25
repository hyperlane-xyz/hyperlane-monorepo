import { Debugger, debug } from 'debug';

import { objMap } from '@hyperlane-xyz/utils';

import { chainMetadata as defaultChainMetadata } from '../consts/chainMetadata';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager';
import type { ChainMetadata } from '../metadata/chainMetadataTypes';
import type { ChainMap, ChainName } from '../types';

import type { MultiProvider } from './MultiProvider';
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

export interface MultiProtocolProviderOptions {
  loggerName?: string;
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
  protected readonly providers: ChainMap<ProviderMap<TypedProvider>> = {};
  protected signers: ChainMap<ProviderMap<never>> = {}; // TODO signer support
  protected readonly logger: Debugger;
  protected readonly providerBuilders: Partial<ProviderBuilderMap>;

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

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProtocolProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProtocolProvider(newMetadata, this.options);
  }

  tryGetProvider(
    chainNameOrId: ChainName | number,
    type: ProviderType,
  ): TypedProvider | null {
    const metadata = this.tryGetChainMetadata(chainNameOrId);
    if (!metadata) return null;
    const { name, chainId, rpcUrls } = metadata;

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
    type: ProviderType,
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
  //   const provider = this.getProvider(chainNameOrId, ProviderType.EthersV5);
  //   if (provider.type !== ProviderType.EthersV6)
  //     throw new Error('Invalid provider type');
  //   return provider.provider;
  // }

  getViemProvider(chainNameOrId: ChainName | number): ViemProvider['provider'] {
    const provider = this.getProvider(chainNameOrId, ProviderType.EthersV5);
    if (provider.type !== ProviderType.Viem)
      throw new Error('Invalid provider type');
    return provider.provider;
  }

  getSolanaWeb3Provider(
    chainNameOrId: ChainName | number,
  ): SolanaWeb3Provider['provider'] {
    const provider = this.getProvider(chainNameOrId, ProviderType.EthersV5);
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
}
