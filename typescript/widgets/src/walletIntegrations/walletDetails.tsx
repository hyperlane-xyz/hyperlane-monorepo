import { useMemo } from 'react';

import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoWalletDetails } from './aleo.js';
import { useCosmosWalletDetails } from './cosmos.js';
import { useEthereumWalletDetails } from './ethereum.js';
import { useRadixWalletDetails } from './radix.js';
import { useSolanaWalletDetails } from './solana.js';
import { useStarknetWalletDetails } from './starknet.js';
import { type WalletDetails } from './types.js';
import { useTronWalletDetails } from './tron.js';

export function useWalletDetails(): Record<KnownProtocolType, WalletDetails> {
  const evmWallet = useEthereumWalletDetails();
  const solWallet = useSolanaWalletDetails();
  const cosmosWallet = useCosmosWalletDetails();
  const starknetWallet = useStarknetWalletDetails();
  const radixWallet = useRadixWalletDetails();
  const aleoWallet = useAleoWalletDetails();
  const tronWallet = useTronWalletDetails();

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: evmWallet,
      [ProtocolType.Sealevel]: solWallet,
      [ProtocolType.Cosmos]: cosmosWallet,
      [ProtocolType.CosmosNative]: cosmosWallet,
      [ProtocolType.Starknet]: starknetWallet,
      [ProtocolType.Radix]: radixWallet,
      [ProtocolType.Aleo]: aleoWallet,
      [ProtocolType.Tron]: tronWallet,
    }),
    [
      evmWallet,
      solWallet,
      cosmosWallet,
      starknetWallet,
      radixWallet,
      aleoWallet,
      tronWallet,
    ],
  );
}
