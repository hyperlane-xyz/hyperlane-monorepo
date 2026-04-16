import { Provider as ZKProvider } from 'zksync-ethers';

import { assert } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { ZKSyncProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultZKSyncProviderBuilder: ProviderBuilderFn<ZKSyncProvider> = (
  rpcUrls: RpcUrl[],
  network: number | string,
) => {
  assert(rpcUrls.length, 'No RPC URLs provided');
  const url = rpcUrls[0].http;
  const provider = new ZKProvider(url, network);
  return { type: ProviderType.ZkSync, provider };
};

export function defaultZKProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
): ZKProvider {
  return defaultZKSyncProviderBuilder(rpcUrls, network).provider;
}
