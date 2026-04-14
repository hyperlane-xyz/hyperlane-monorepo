import { RpcProvider as StarknetRpcProvider } from 'starknet';

import { assert } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import { parseCustomRpcHeaders } from '../../utils/provider.js';
import type { StarknetJsProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultStarknetJsProviderBuilder: ProviderBuilderFn<
  StarknetJsProvider
> = (rpcUrls: RpcUrl[]) => {
  assert(rpcUrls.length, 'No RPC URLs provided');
  const { url, headers } = parseCustomRpcHeaders(rpcUrls[0].http);
  const provider = new StarknetRpcProvider({
    nodeUrl: url,
    headers,
  });
  return { provider, type: ProviderType.Starknet };
};
