import type { Chain as WagmiChain } from '@wagmi/chains';

import { ChainMetadata, etherToken } from '../consts';

export function chainMetadataToWagmiChain(metadata: ChainMetadata): WagmiChain {
  return {
    id: metadata.chainId,
    name: metadata.displayName || metadata.name,
    network: metadata.name as string,
    nativeCurrency: metadata.nativeToken || etherToken,
    rpcUrls: {
      public: { http: [metadata.publicRpcUrls[0].http] },
      default: { http: [metadata.publicRpcUrls[0].http] },
    },
    blockExplorers: metadata.blockExplorers?.length
      ? {
          default: {
            name: metadata.blockExplorers[0].name,
            url: metadata.blockExplorers[0].url,
          },
        }
      : undefined,
    testnet: !!metadata.isTestnet,
  };
}
