import { useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoActiveChain } from './aleoBase.js';
import { useCosmosActiveChain } from './cosmosBase.js';
import { useEthereumActiveChain } from './ethereumBase.js';
import { useRadixActiveChain } from './radixBase.js';
import { useSolanaActiveChain } from './solanaBase.js';
import { useStarknetActiveChain } from './starknetBase.js';
import { type ActiveChainInfo } from './types.js';
import { useTronActiveChain } from './tronBase.js';

export function useActiveChains(multiProvider: MultiProtocolProvider): {
  chains: Record<KnownProtocolType, ActiveChainInfo>;
  readyChains: Array<ActiveChainInfo>;
} {
  const evmChain = useEthereumActiveChain(multiProvider);
  const solChain = useSolanaActiveChain(multiProvider);
  const cosmChain = useCosmosActiveChain(multiProvider);
  const starknetChain = useStarknetActiveChain(multiProvider);
  const radixChain = useRadixActiveChain(multiProvider);
  const aleoChain = useAleoActiveChain(multiProvider);
  const tronChain = useTronActiveChain(multiProvider);

  const readyChains = useMemo(
    () =>
      [
        evmChain,
        solChain,
        cosmChain,
        starknetChain,
        radixChain,
        aleoChain,
        tronChain,
      ].filter((c) => !!c.chainDisplayName),
    [
      evmChain,
      solChain,
      cosmChain,
      starknetChain,
      radixChain,
      aleoChain,
      tronChain,
    ],
  );

  return useMemo(
    () => ({
      chains: {
        [ProtocolType.Ethereum]: evmChain,
        [ProtocolType.Sealevel]: solChain,
        [ProtocolType.Cosmos]: cosmChain,
        [ProtocolType.CosmosNative]: cosmChain,
        [ProtocolType.Starknet]: starknetChain,
        [ProtocolType.Radix]: radixChain,
        [ProtocolType.Aleo]: aleoChain,
        [ProtocolType.Tron]: tronChain,
      },
      readyChains,
    }),
    [
      evmChain,
      solChain,
      cosmChain,
      readyChains,
      starknetChain,
      radixChain,
      aleoChain,
      tronChain,
    ],
  );
}
