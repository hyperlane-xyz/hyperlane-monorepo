import { objFilter, objMap, pick } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName } from '../types.js';

import {
  MinimalProviderRegistry,
  MinimalProviderRegistryOptions,
} from './MinimalProviderRegistry.js';
import { MultiProvider, MultiProviderOptions } from './MultiProvider.js';
import {
  EthersV5Provider,
  ProviderType,
  TypedProvider,
} from './ProviderType.js';

export interface MultiProviderAdapterOptions extends MinimalProviderRegistryOptions {}

export function wrapMultiProviderProviders<MetaExt = {}>(
  providers: MultiProvider<MetaExt>['providers'],
): ChainMap<TypedProvider> {
  return objMap(providers, (_, provider) => ({
    type: ProviderType.EthersV5,
    provider,
  })) as ChainMap<TypedProvider>;
}

export function createAdapterFromMultiProvider<
  MetaExt = {},
  TOptions = MultiProviderAdapterOptions,
  TAdapter extends MultiProviderAdapter<MetaExt> =
    MultiProviderAdapter<MetaExt>,
>(
  AdapterClass: new (
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    options?: TOptions,
  ) => TAdapter,
  mp: MultiProvider<MetaExt>,
  options?: TOptions,
): TAdapter {
  const newMp = new AdapterClass(mp.metadata, options);
  newMp.setProviders(wrapMultiProviderProviders(mp.providers));
  return newMp;
}

export class MultiProviderAdapter<
  MetaExt = {},
> extends MinimalProviderRegistry<MetaExt> {
  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: MultiProviderAdapterOptions = {},
  ) {
    super(chainMetadata, options);
  }

  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: MultiProviderAdapterOptions = {},
  ): MultiProviderAdapter<MetaExt> {
    return createAdapterFromMultiProvider(MultiProviderAdapter, mp, options);
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
  ): MultiProviderAdapter<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProviderAdapter(newMetadata, {
      ...this.options,
      providers: this.providers,
      providerBuilders: this.providerBuilders,
    });
  }

  override intersect(
    chains: ChainName[],
    throwIfNotSubset = false,
  ): {
    intersection: ChainName[];
    result: MultiProviderAdapter<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    return {
      intersection,
      result: new MultiProviderAdapter(result.metadata, {
        ...this.options,
        providers: pick(this.providers, intersection),
        providerBuilders: this.providerBuilders,
      }),
    };
  }
}
