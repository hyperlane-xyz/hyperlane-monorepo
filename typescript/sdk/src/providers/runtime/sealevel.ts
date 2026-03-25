import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultSolProviderBuilder } from '../builders/solana.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeMultiProvider,
  type ProtocolRuntimeMultiProtocolProvider,
  type ProtocolRuntimeMultiProtocolProviderOptions,
} from './utils.js';

export const sealevelRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.SolanaWeb3]: defaultSolProviderBuilder,
};

export function createSealevelRuntimeMultiProvider<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeMultiProtocolProviderOptions = {},
): ProtocolRuntimeMultiProtocolProvider<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Sealevel],
    createSealevelRuntimeMultiProvider.name,
  );
  return createProtocolRuntimeMultiProvider(
    chainMetadata,
    sealevelRuntimeProviderBuilders,
    options,
  );
}
