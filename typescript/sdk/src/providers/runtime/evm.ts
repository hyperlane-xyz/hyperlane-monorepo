import {
  defaultEthersV5ProviderBuilder,
  defaultGnosisTxBuilderProviderBuilder,
} from '../builders/ethersV5.js';
import { defaultViemProviderBuilder } from '../builders/viem.js';
import { defaultZKSyncProviderBuilder } from '../builders/zksync.js';
import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';

export const evmRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.EthersV5]: defaultEthersV5ProviderBuilder,
  [ProviderType.GnosisTxBuilder]: defaultGnosisTxBuilderProviderBuilder,
  [ProviderType.Viem]: defaultViemProviderBuilder,
  [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
};
