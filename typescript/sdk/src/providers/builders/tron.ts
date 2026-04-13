import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk/runtime';
import { assert } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { EthersV5Provider, TronProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

/**
 * Returns an ethers-compatible TronJsonRpcProvider for use in MultiProvider.
 * This handles Tron's missing eth_getTransactionCount and returns the raw provider.
 */
export function defaultTronEthersProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
): EthersV5Provider['provider'] {
  assert(rpcUrls.length > 0, 'At least one RPC URL required for Tron');
  return new TronJsonRpcProvider(rpcUrls[0].http, network);
}

export const defaultTronProviderBuilder: ProviderBuilderFn<TronProvider> = (
  rpcUrls: RpcUrl[],
  network: string | number,
) => {
  assert(rpcUrls.length > 0, 'At least one RPC URL required for Tron');
  return {
    provider: new TronJsonRpcProvider(rpcUrls[0].http, network),
    type: ProviderType.Tron,
  };
};
