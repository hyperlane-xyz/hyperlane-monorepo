import { createPublicClient, http } from 'viem';

import { isNumeric } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { ViemProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultViemProviderBuilder: ProviderBuilderFn<ViemProvider> = (
  rpcUrls: RpcUrl[],
  network: number | string,
) => {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  if (!isNumeric(network)) throw new Error('Viem requires a numeric network');
  const id = parseInt(network.toString(), 10);
  const name = network.toString();
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
