import type { Chain as WagmiChain } from '@wagmi/chains';

import type { ChainMetadata } from '../consts/chainMetadata';
import { Testnets } from '../consts/chains';

export function chainMetadataToWagmiChain(metadata: ChainMetadata): WagmiChain {
  return {
    id: metadata.id,
    name: metadata.displayName,
    network: metadata.name as string,
    nativeCurrency: metadata.nativeToken,
    rpcUrls: {
      public: { http: [metadata.publicRpcUrls[0].http] },
      default: { http: [metadata.publicRpcUrls[0].http] },
    },
    blockExplorers: metadata.blockExplorers.length
      ? {
          default: {
            name: metadata.blockExplorers[0].name,
            url: metadata.blockExplorers[0].url,
          },
        }
      : undefined,
    testnet: Testnets.includes(metadata.name),
  };
}
