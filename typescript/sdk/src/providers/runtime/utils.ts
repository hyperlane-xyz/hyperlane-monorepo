import { type KnownProtocolType, assert } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import {
  ConfiguredMultiProtocolProvider,
  type ConfiguredMultiProtocolProviderOptions,
} from '../ConfiguredMultiProtocolProvider.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';

export type ProtocolRuntimeMultiProtocolProvider<MetaExt = {}> =
  ConfiguredMultiProtocolProvider<MetaExt>;

export interface ProtocolRuntimeMultiProtocolProviderOptions extends Omit<
  ConfiguredMultiProtocolProviderOptions,
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

export function createProtocolRuntimeMultiProvider<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  providerBuilders: Partial<ProviderBuilderMap>,
  options: ProtocolRuntimeMultiProtocolProviderOptions = {},
): ProtocolRuntimeMultiProtocolProvider<MetaExt> {
  return new ConfiguredMultiProtocolProvider(chainMetadata, {
    ...options,
    providerBuilders: {
      ...providerBuilders,
      ...options.providerBuilders,
    },
  });
}
