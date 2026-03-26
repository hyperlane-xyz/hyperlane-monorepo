import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultRadixProviderBuilder } from '../builders/radix.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistryOptions,
} from './utils.js';

export const radixRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.Radix]: defaultRadixProviderBuilder,
};

export function createRadixRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Radix],
    createRadixRuntimeProviderRegistry.name,
  );
  return createProtocolRuntimeProviderRegistry(
    chainMetadata,
    radixRuntimeProviderBuilders,
    options,
  );
}
