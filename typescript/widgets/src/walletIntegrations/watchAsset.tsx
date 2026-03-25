import { useMemo } from 'react';

import type { MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/MultiProtocolProvider';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoWatchAsset } from './aleo.js';
import { useCosmosWatchAsset } from './cosmos.js';
import { useEthereumWatchAsset } from './ethereum.js';
import { useRadixWatchAsset } from './radix.js';
import { useSolanaWatchAsset } from './solana.js';
import { useStarknetWatchAsset } from './starknet.js';
import { type WatchAssetFns } from './types.js';
import { useTronWatchAsset } from './tron.js';

export function useWatchAsset(
  multiProvider: MultiProtocolProvider,
): Record<KnownProtocolType, WatchAssetFns> {
  const { addAsset: evmAddAsset } = useEthereumWatchAsset(multiProvider);
  const { addAsset: solanaAddAsset } = useSolanaWatchAsset(multiProvider);
  const { addAsset: cosmosAddAsset } = useCosmosWatchAsset(multiProvider);
  const { addAsset: starknetAddAsset } = useStarknetWatchAsset(multiProvider);
  const { addAsset: radixAddAsset } = useRadixWatchAsset(multiProvider);
  const { addAsset: aleoAddAsset } = useAleoWatchAsset(multiProvider);
  const { addAsset: tronAddAsset } = useTronWatchAsset(multiProvider);

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: {
        addAsset: evmAddAsset,
      },
      [ProtocolType.Sealevel]: {
        addAsset: solanaAddAsset,
      },
      [ProtocolType.Cosmos]: {
        addAsset: cosmosAddAsset,
      },
      [ProtocolType.CosmosNative]: {
        addAsset: cosmosAddAsset,
      },
      [ProtocolType.Starknet]: {
        addAsset: starknetAddAsset,
      },
      [ProtocolType.Radix]: {
        addAsset: radixAddAsset,
      },
      [ProtocolType.Aleo]: {
        addAsset: aleoAddAsset,
      },
      [ProtocolType.Tron]: {
        addAsset: tronAddAsset,
      },
    }),
    [
      evmAddAsset,
      solanaAddAsset,
      cosmosAddAsset,
      starknetAddAsset,
      radixAddAsset,
      aleoAddAsset,
      tronAddAsset,
    ],
  );
}
