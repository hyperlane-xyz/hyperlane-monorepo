import { createPublicClient, http } from 'viem';

import { isNumeric } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { ViemProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultViemProviderBuilder: ProviderBuilderFn<ViemProvider> = (
  metadata: ChainMetadata,
) => {
  const { rpcUrls, chainId } = metadata;
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  if (!isNumeric(chainId)) throw new Error('Viem requires a numeric network');
  const id = parseInt(chainId.toString(), 10);
  const name = chainId.toString();
  const url = rpcUrls[0].http;
  const client = createPublicClient({
    chain: {
      id,
      name,
      network: name,
      nativeCurrency: { name: '', symbol: '', decimals: 0 },
      rpcUrls: { default: { http: [url] }, public: { http: [url] } },
    },
    transport: http(url),
  });
  return { type: ProviderType.Viem, provider: client };
};
