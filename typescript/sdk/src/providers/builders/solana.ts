import { Connection } from '@solana/web3.js';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { SolanaWeb3Provider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultSolProviderBuilder: ProviderBuilderFn<
  SolanaWeb3Provider
> = (rpcUrls: RpcUrl[]) => {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.SolanaWeb3,
    provider: new Connection(rpcUrls[0].http, 'confirmed'),
  };
};
