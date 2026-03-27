import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../../types.js';

import { defaultEthersV5ProviderBuilder } from '../builders/ethersV5.js';
import { defaultViemProviderBuilder } from '../builders/viem.js';
import { defaultZKSyncProviderBuilder } from '../builders/zksync.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

import {
  assertProtocolRuntimeMetadata,
  createProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistry,
  type ProtocolRuntimeProviderRegistryOptions,
} from './utils.js';

export const evmRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.EthersV5]: defaultEthersV5ProviderBuilder,
  [ProviderType.GnosisTxBuilder]: defaultEthersV5ProviderBuilder,
  [ProviderType.Viem]: defaultViemProviderBuilder,
  [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
};

export function createEvmRuntimeProviderRegistry<MetaExt>(
  chainMetadata: ChainMap<ChainMetadata<MetaExt>>,
  options: ProtocolRuntimeProviderRegistryOptions = {},
): ProtocolRuntimeProviderRegistry<MetaExt> {
  assertProtocolRuntimeMetadata(
    chainMetadata,
    [ProtocolType.Ethereum],
    createEvmRuntimeProviderRegistry.name,
  );
  return createProtocolRuntimeProviderRegistry(
    chainMetadata,
    evmRuntimeProviderBuilders,
    options,
  );
}
