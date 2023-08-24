import type { Chain as WagmiChain } from '@wagmi/chains';

import { objMap } from '@hyperlane-xyz/utils';

import { chainMetadata, etherToken } from '../consts/chainMetadata';
import type { ChainMetadata } from '../metadata/chainMetadataTypes';
import type { ChainMap } from '../types';

// For convenient use in wagmi-based apps
export const wagmiChainMetadata: ChainMap<WagmiChain> = objMap(
  chainMetadata,
  (_, metadata) => chainMetadataToWagmiChain(metadata),
);

export function chainMetadataToWagmiChain(metadata: ChainMetadata): WagmiChain {
  return {
    id: metadata.chainId,
    name: metadata.displayName || metadata.name,
    network: metadata.name as string,
    nativeCurrency: metadata.nativeToken || etherToken,
    rpcUrls: {
      public: { http: [metadata.rpcUrls[0].http] },
      default: { http: [metadata.rpcUrls[0].http] },
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
