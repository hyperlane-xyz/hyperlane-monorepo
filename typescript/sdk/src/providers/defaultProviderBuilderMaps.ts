import { ProtocolType } from '@hyperlane-xyz/utils';

import type { KnownProtocolType, TypedProvider } from './ProviderType.js';
import { ProviderType } from './ProviderType.js';
import { defaultAleoProviderBuilder } from './builders/aleo.js';
import {
  defaultCosmJsNativeProviderBuilder,
  defaultCosmJsProviderBuilder,
  defaultCosmJsWasmProviderBuilder,
} from './builders/cosmos.js';
import { defaultEthersV5ProviderBuilder } from './builders/ethersV5.js';
import { defaultRadixProviderBuilder } from './builders/radix.js';
import { defaultSolProviderBuilder } from './builders/solana.js';
import { defaultStarknetJsProviderBuilder } from './builders/starknet.js';
import { defaultTronProviderBuilder } from './builders/tron.js';
import { defaultViemProviderBuilder } from './builders/viem.js';
import { defaultZKSyncProviderBuilder } from './builders/zksync.js';
import type { ProviderBuilderFn } from './builders/types.js';

export type ProviderBuilderMap = Record<
  ProviderType,
  ProviderBuilderFn<TypedProvider>
>;

export const defaultProviderBuilderMap: ProviderBuilderMap = {
  [ProviderType.EthersV5]: defaultEthersV5ProviderBuilder,
  [ProviderType.GnosisTxBuilder]: defaultEthersV5ProviderBuilder,
  [ProviderType.Viem]: defaultViemProviderBuilder,
  [ProviderType.SolanaWeb3]: defaultSolProviderBuilder,
  [ProviderType.CosmJs]: defaultCosmJsProviderBuilder,
  [ProviderType.CosmJsWasm]: defaultCosmJsWasmProviderBuilder,
  [ProviderType.CosmJsNative]: defaultCosmJsNativeProviderBuilder,
  [ProviderType.Starknet]: defaultStarknetJsProviderBuilder,
  [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
  [ProviderType.Radix]: defaultRadixProviderBuilder,
  [ProviderType.Aleo]: defaultAleoProviderBuilder,
  [ProviderType.Tron]: defaultTronProviderBuilder,
};

export const protocolToDefaultProviderBuilder: Record<
  KnownProtocolType,
  ProviderBuilderFn<TypedProvider>
> = {
  [ProtocolType.Ethereum]: defaultEthersV5ProviderBuilder,
  [ProtocolType.Sealevel]: defaultSolProviderBuilder,
  [ProtocolType.Cosmos]: defaultCosmJsWasmProviderBuilder,
  [ProtocolType.CosmosNative]: defaultCosmJsNativeProviderBuilder,
  [ProtocolType.Starknet]: defaultStarknetJsProviderBuilder,
  [ProtocolType.Radix]: defaultRadixProviderBuilder,
  [ProtocolType.Aleo]: defaultAleoProviderBuilder,
  [ProtocolType.Tron]: defaultTronProviderBuilder,
};
