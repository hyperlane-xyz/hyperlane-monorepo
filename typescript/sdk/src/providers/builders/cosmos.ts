import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { StargateClient } from '@cosmjs/stargate';

import { CosmosNativeProvider } from '@hyperlane-xyz/cosmos-sdk/runtime';
import { assert } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type {
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
} from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultCosmJsProviderBuilder: ProviderBuilderFn<CosmJsProvider> = (
  rpcUrls: RpcUrl[],
) => {
  assert(rpcUrls.length > 0, 'No RPC URLs provided');
  return {
    type: ProviderType.CosmJs,
    provider: StargateClient.connect(rpcUrls[0].http),
  };
};

export const defaultCosmJsWasmProviderBuilder: ProviderBuilderFn<
  CosmJsWasmProvider
> = (rpcUrls: RpcUrl[]) => {
  assert(rpcUrls.length > 0, 'No RPC URLs provided');
  return {
    type: ProviderType.CosmJsWasm,
    provider: CosmWasmClient.connect(rpcUrls[0].http),
  };
};

export const defaultCosmJsNativeProviderBuilder: ProviderBuilderFn<
  CosmJsNativeProvider
> = (rpcUrls: RpcUrl[], network: number | string) => {
  assert(rpcUrls.length > 0, 'No RPC URLs provided');
  return {
    type: ProviderType.CosmJsNative,
    provider: CosmosNativeProvider.connect(
      rpcUrls.map((rpc) => rpc.http),
      network,
    ),
  };
};
