import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import {
  defaultTronEthersProviderBuilder,
  defaultTronProviderBuilder,
} from '../builders/tron.js';
import type { ProviderBuilderFn } from '../builders/types.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType, type TypedProvider } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistryOptions,
} from './utils.js';

const defaultTronEthersTypedProviderBuilder: ProviderBuilderFn<
  TypedProvider
> = (rpcUrls, network) => ({
  type: ProviderType.EthersV5,
  provider: defaultTronEthersProviderBuilder(rpcUrls, network),
});

export const tronRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.EthersV5]: defaultTronEthersTypedProviderBuilder,
  [ProviderType.Tron]: defaultTronProviderBuilder,
};

export function createTronRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Tron],
    createTronRuntimeProviderRegistry.name,
  );
  return createProtocolRuntimeProviderRegistry(
    chainMetadata,
    tronRuntimeProviderBuilders,
    options,
  );
}
