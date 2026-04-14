import { pick } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName } from '../types.js';

import {
  createAdapterFromMultiProvider,
  MultiProviderAdapter,
  MultiProviderAdapterOptions,
} from './MultiProviderAdapter.js';
import { MultiProvider } from './MultiProvider.js';

export interface MultiProtocolProviderOptions extends MultiProviderAdapterOptions {}

export class MultiProtocolProvider<
  MetaExt = {},
> extends MultiProviderAdapter<MetaExt> {
  static fromMultiProvider<MetaExt = {}>(
    mp: MultiProvider<MetaExt>,
    options: MultiProtocolProviderOptions = {},
  ): MultiProtocolProvider<MetaExt> {
    return createAdapterFromMultiProvider(MultiProtocolProvider, mp, options);
  }

  constructor(
    chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
    options: MultiProtocolProviderOptions = {},
  ) {
    super(chainMetadata, options);
  }

  override extendChainMetadata<NewExt = {}>(
    additionalMetadata: ChainMap<NewExt>,
  ): MultiProtocolProvider<MetaExt & NewExt> {
    const newMetadata = super.extendChainMetadata(additionalMetadata).metadata;
    return new MultiProtocolProvider(newMetadata, {
      ...this.options,
      providers: this.providers,
      providerBuilders: this.providerBuilders,
      protocolProviderBuilders: this.protocolProviderBuilders,
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
        providers: pick(this.providers, intersection),
        providerBuilders: this.providerBuilders,
        protocolProviderBuilders: this.protocolProviderBuilders,
      }),
    };
  }
}
