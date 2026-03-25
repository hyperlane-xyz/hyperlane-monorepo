import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultAleoProviderBuilder } from '../builders/aleo.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeMultiProvider,
  type ProtocolRuntimeMultiProtocolProvider,
  type ProtocolRuntimeMultiProtocolProviderOptions,
} from './utils.js';

export const aleoRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.Aleo]: defaultAleoProviderBuilder,
};

export function createAleoRuntimeMultiProvider<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeMultiProtocolProviderOptions = {},
): ProtocolRuntimeMultiProtocolProvider<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Aleo],
    createAleoRuntimeMultiProvider.name,
  );
  return createProtocolRuntimeMultiProvider(
    chainMetadata,
    aleoRuntimeProviderBuilders,
    options,
  );
}
