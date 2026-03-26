import { objFilter, objMap, pick } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName } from '../types.js';

import {
  ConfiguredProviderRegistry,
  ConfiguredProviderRegistryOptions,
} from './ConfiguredProviderRegistry.js';
import { MultiProvider, MultiProviderOptions } from './MultiProvider.js';
import {
  EthersV5Provider,
  ProviderType,
  TypedProvider,
} from './ProviderType.js';

export interface ConfiguredMultiProtocolProviderOptions extends ConfiguredProviderRegistryOptions {}

export function wrapMultiProviderProviders<MetaExt = {}>(
  providers: MultiProvider<MetaExt>['providers'],
): ChainMap<TypedProvider> {
  return objMap(providers, (_, provider) => ({
    type: ProviderType.EthersV5,
    provider,
  })) as ChainMap<TypedProvider>;
}

export class ConfiguredMultiProtocolProvider<
  MetaExt = {},
> extends ConfiguredProviderRegistry<MetaExt> {
  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    protected readonly options: ConfiguredMultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, options);
  }

  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: ConfiguredMultiProtocolProviderOptions = {},
  ): ConfiguredMultiProtocolProvider<MetaExt> {
    const newMp = new ConfiguredMultiProtocolProvider<MetaExt>(
      mp.metadata,
      options,
    );
    newMp.setProviders(wrapMultiProviderProviders(mp.providers));
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
  ): ConfiguredMultiProtocolProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new ConfiguredMultiProtocolProvider(newMetadata, {
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
    result: ConfiguredMultiProtocolProvider<MetaExt>;
  } {
    const { intersection, result } = super.intersect(chains, throwIfNotSubset);
    return {
      intersection,
      result: new ConfiguredMultiProtocolProvider(result.metadata, {
        ...this.options,
        providers: pick(this.providers, intersection),
        providerBuilders: this.providerBuilders,
      }),
    };
  }
}
