import { Provider as ZKProvider } from 'zksync-ethers';

import { assert } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ZKSyncProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultZKSyncProviderBuilder: ProviderBuilderFn<ZKSyncProvider> = (
  metadata: ChainMetadata,
) => {
  const { rpcUrls, chainId } = metadata;
  assert(rpcUrls.length, 'No RPC URLs provided');
  const url = rpcUrls[0].http;
  const provider = new ZKProvider(url, chainId);
  return { type: ProviderType.ZkSync, provider };
};

export function defaultZKProviderBuilder(metadata: ChainMetadata): ZKProvider {
  return defaultZKSyncProviderBuilder(metadata).provider;
}
