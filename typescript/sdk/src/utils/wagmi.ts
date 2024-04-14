import type { Chain as WagmiChain } from '@wagmi/chains';

import { ProtocolType, objFilter, objMap } from '@hyperlane-xyz/utils';

import { chainMetadata, etherToken } from '../consts/chainMetadata.js';
import {
  ChainMetadata,
  getChainIdNumber,
} from '../metadata/chainMetadataTypes.js';
import type { ChainMap } from '../types.js';

// For convenient use in wagmi-based apps
export const wagmiChainMetadata: ChainMap<WagmiChain> = objMap(
  objFilter(
    chainMetadata,
    (_, metadata): metadata is ChainMetadata =>
      metadata.protocol === ProtocolType.Ethereum,
  ),
  (_, metadata) => chainMetadataToWagmiChain(metadata),
);

export function chainMetadataToWagmiChain(metadata: ChainMetadata): WagmiChain {
  return {
    id: getChainIdNumber(metadata),
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
