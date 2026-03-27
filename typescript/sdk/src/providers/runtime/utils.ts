import { type KnownProtocolType, assert } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import {
  MinimalProviderRegistry,
  type MinimalProviderRegistryOptions,
} from '../MinimalProviderRegistry.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';

export type ProtocolRuntimeProviderRegistry<MetaExt = {}> =
  MinimalProviderRegistry<MetaExt>;

export interface ProtocolRuntimeProviderRegistryOptions extends Omit<
  MinimalProviderRegistryOptions,
  'providerBuilders'
> {
  providerBuilders?: Partial<ProviderBuilderMap>;
}

export function assertProtocolRuntimeMetadata<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  allowedProtocols: KnownProtocolType[],
  helperName: string,
): void {
  const invalidChains = Object.values(chainMetadata).filter(
    (metadata) =>
      !allowedProtocols.includes(metadata.protocol as KnownProtocolType),
  );

  assert(
    invalidChains.length === 0,
    `${helperName} only supports ${allowedProtocols.join(', ')} chain metadata`,
  );
}

export function createProtocolRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  providerBuilders: Partial<ProviderBuilderMap>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  return new MinimalProviderRegistry(chainMetadata, {
    ...options,
    providerBuilders: {
      ...providerBuilders,
      ...options.providerBuilders,
    },
  });
}
