import { useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAleoTransactionFns } from './aleo.js';
import { useCosmosTransactionFns } from './cosmos.js';
import { useEthereumTransactionFns } from './ethereum.js';
import { useRadixTransactionFns } from './radix.js';
import { useSolanaTransactionFns } from './solana.js';
import { useStarknetTransactionFns } from './starknet.js';
import { type ChainTransactionFns } from './types.js';
import { useTronTransactionFns } from './tron.js';

export function useTransactionFns(
  multiProvider: MultiProtocolProvider,
): Record<KnownProtocolType, ChainTransactionFns> {
  const {
    switchNetwork: onSwitchEvmNetwork,
    sendTransaction: onSendEvmTx,
    sendMultiTransaction: onSendMultiEvmTx,
  } = useEthereumTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchSolNetwork,
    sendTransaction: onSendSolTx,
    sendMultiTransaction: onSendMultiSolTx,
  } = useSolanaTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchCosmNetwork,
    sendTransaction: onSendCosmTx,
    sendMultiTransaction: onSendMultiCosmTx,
  } = useCosmosTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchStarknetNetwork,
    sendTransaction: onSendStarknetTx,
    sendMultiTransaction: onSendMultiStarknetTx,
  } = useStarknetTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchRadixNetwork,
    sendTransaction: onSendRadixTx,
    sendMultiTransaction: onSendMultiRadixTx,
  } = useRadixTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchAleoNetwork,
    sendTransaction: onSendAleoTx,
    sendMultiTransaction: onSendMultiAleoTx,
  } = useAleoTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchTronNetwork,
    sendTransaction: onSendTronTx,
    sendMultiTransaction: onSendMultiTronTx,
  } = useTronTransactionFns(multiProvider);

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: {
        sendTransaction: onSendEvmTx,
        sendMultiTransaction: onSendMultiEvmTx,
        switchNetwork: onSwitchEvmNetwork,
      },
      [ProtocolType.Sealevel]: {
        sendTransaction: onSendSolTx,
        sendMultiTransaction: onSendMultiSolTx,
        switchNetwork: onSwitchSolNetwork,
      },
      [ProtocolType.Cosmos]: {
        sendTransaction: onSendCosmTx,
        sendMultiTransaction: onSendMultiCosmTx,
        switchNetwork: onSwitchCosmNetwork,
      },
      [ProtocolType.CosmosNative]: {
        sendTransaction: onSendCosmTx,
        sendMultiTransaction: onSendMultiCosmTx,
        switchNetwork: onSwitchCosmNetwork,
      },
      [ProtocolType.Starknet]: {
        sendTransaction: onSendStarknetTx,
        sendMultiTransaction: onSendMultiStarknetTx,
        switchNetwork: onSwitchStarknetNetwork,
      },
      [ProtocolType.Radix]: {
        sendTransaction: onSendRadixTx,
        sendMultiTransaction: onSendMultiRadixTx,
        switchNetwork: onSwitchRadixNetwork,
      },
      [ProtocolType.Aleo]: {
        sendTransaction: onSendAleoTx,
        sendMultiTransaction: onSendMultiAleoTx,
        switchNetwork: onSwitchAleoNetwork,
      },
      [ProtocolType.Tron]: {
        sendTransaction: onSendTronTx,
        sendMultiTransaction: onSendMultiTronTx,
        switchNetwork: onSwitchTronNetwork,
      },
    }),
    [
      onSendEvmTx,
      onSendMultiEvmTx,
      onSendSolTx,
      onSendMultiSolTx,
      onSwitchEvmNetwork,
      onSwitchSolNetwork,
      onSendCosmTx,
      onSendMultiCosmTx,
      onSwitchCosmNetwork,
      onSendStarknetTx,
      onSendMultiStarknetTx,
      onSwitchStarknetNetwork,
      onSendRadixTx,
      onSendMultiRadixTx,
      onSwitchRadixNetwork,
      onSendAleoTx,
      onSendMultiAleoTx,
      onSwitchAleoNetwork,
      onSendTronTx,
      onSendMultiTronTx,
      onSwitchTronNetwork,
    ],
  );
}
