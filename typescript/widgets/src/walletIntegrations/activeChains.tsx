import { useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoActiveChain } from './aleo.js';
import { useCosmosActiveChain } from './cosmos.js';
import { useEthereumActiveChain } from './ethereum.js';
import { useRadixActiveChain } from './radix.js';
import { useSolanaActiveChain } from './solana.js';
import { useStarknetActiveChain } from './starknet.js';
import { type ActiveChainInfo } from './types.js';
import { useTronActiveChain } from './tron.js';

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
