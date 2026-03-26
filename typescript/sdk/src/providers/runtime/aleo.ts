import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultAleoProviderBuilder } from '../builders/aleo.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistryOptions,
} from './utils.js';

export const aleoRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.Aleo]: defaultAleoProviderBuilder,
};

export function createAleoRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Aleo],
    createAleoRuntimeProviderRegistry.name,
  );
  return createProtocolRuntimeProviderRegistry(
    chainMetadata,
    aleoRuntimeProviderBuilders,
    options,
  );
}
