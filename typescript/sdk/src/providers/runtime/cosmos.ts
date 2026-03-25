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
  createProtocolRuntimeMultiProvider,
  type ProtocolRuntimeMultiProtocolProvider,
  type ProtocolRuntimeMultiProtocolProviderOptions,
} from './utils.js';

export const cosmosRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.CosmJs]: defaultCosmJsProviderBuilder,
  [ProviderType.CosmJsWasm]: defaultCosmJsWasmProviderBuilder,
  [ProviderType.CosmJsNative]: defaultCosmJsNativeProviderBuilder,
};

export function createCosmosRuntimeMultiProvider<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeMultiProtocolProviderOptions = {},
): ProtocolRuntimeMultiProtocolProvider<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Cosmos, ProtocolType.CosmosNative],
    createCosmosRuntimeMultiProvider.name,
  );
  return createProtocolRuntimeMultiProvider(
    chainMetadata,
    cosmosRuntimeProviderBuilders,
    options,
  );
}
