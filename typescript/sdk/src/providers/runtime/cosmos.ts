import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import {
  defaultCosmJsNativeProviderBuilder,
  defaultCosmJsProviderBuilder,
  defaultCosmJsWasmProviderBuilder,
} from '../builders/cosmos.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistryOptions,
} from './utils.js';

export const cosmosRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.CosmJs]: defaultCosmJsProviderBuilder,
  [ProviderType.CosmJsWasm]: defaultCosmJsWasmProviderBuilder,
  [ProviderType.CosmJsNative]: defaultCosmJsNativeProviderBuilder,
};

export function createCosmosRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Cosmos, ProtocolType.CosmosNative],
    createCosmosRuntimeProviderRegistry.name,
  );
  return createProtocolRuntimeProviderRegistry(
    chainMetadata,
    cosmosRuntimeProviderBuilders,
    options,
  );
}
