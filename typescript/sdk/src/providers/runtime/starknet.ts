import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultStarknetJsProviderBuilder } from '../builders/starknet.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeMultiProvider,
  type ProtocolRuntimeMultiProtocolProvider,
  type ProtocolRuntimeMultiProtocolProviderOptions,
} from './utils.js';

export const starknetRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.Starknet]: defaultStarknetJsProviderBuilder,
};

export function createStarknetRuntimeMultiProvider<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeMultiProtocolProviderOptions = {},
): ProtocolRuntimeMultiProtocolProvider<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Starknet],
    createStarknetRuntimeMultiProvider.name,
  );
  return createProtocolRuntimeMultiProvider(
    chainMetadata,
    starknetRuntimeProviderBuilders,
    options,
  );
}
