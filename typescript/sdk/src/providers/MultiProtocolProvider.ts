import { ProtocolType } from '@hyperlane-xyz/utils';

import { multiProtocolTestChainMetadata } from '../consts/testChains.js';
import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName } from '../types.js';

import {
  MultiProviderAdapter,
  MultiProviderAdapterOptions,
  wrapMultiProviderProviders,
} from './MultiProviderAdapter.js';
import { MultiProvider } from './MultiProvider.js';
import { ProviderType, TypedProvider } from './ProviderType.js';
import {
  ProviderBuilderMap,
  defaultTronEthersProviderBuilder,
} from './providerBuilders.js';
import { defaultProviderBuilderMap } from './defaultProviderBuilderMaps.js';
import type { ProviderBuilderFn } from './providerBuilders.js';

export interface MultiProtocolProviderOptions extends MultiProviderAdapterOptions {}

export class MultiProtocolProvider<
  MetaExt = {},
> extends MultiProviderAdapter<MetaExt> {
  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: MultiProtocolProviderOptions = {},
  ): MultiProtocolProvider<MetaExt> {
    const newMp = new MultiProtocolProvider<MetaExt>(mp.metadata, options);
    newMp.setProviders(wrapMultiProviderProviders(mp.providers));
    return newMp;
  }

  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    options: MultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, {
      ...options,
      providerBuilders: options.providerBuilders || defaultProviderBuilderMap,
    });
  }

  protected override getProviderBuilder(
    protocol: ProtocolType,
    type: ProviderType,
  ): ProviderBuilderFn<TypedProvider> | undefined {
    if (protocol === ProtocolType.Tron && type === ProviderType.EthersV5) {
      return (urls, network) => ({
        type: ProviderType.EthersV5,
        provider: defaultTronEthersProviderBuilder(urls, network),
      });
    }
    return this.providerBuilders[type];
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProtocolProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProtocolProvider(newMetadata, {
      ...this.options,
      providers: this.providers,
      providerBuilders: this.providerBuilders as Partial<ProviderBuilderMap>,
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
    return {
      intersection,
      result: new MultiProtocolProvider(result.metadata, {
        ...this.options,
        providers: Object.fromEntries(
          Object.entries(this.providers).filter(([chain]) =>
            intersection.includes(chain),
          ),
        ),
        providerBuilders: this.providerBuilders,
      }),
    };
  }

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
