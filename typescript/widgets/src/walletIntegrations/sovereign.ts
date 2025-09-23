import { useCallback, useMemo } from 'react';

import {
  ChainName,
  IToken,
  MultiProtocolProvider,
  ProviderType,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

export function useSovereignAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  return useMemo<AccountInfo>(
    () => ({
      protocol: ProtocolType.Sovereign,
      addresses: [],
      isReady: true,
    }),
    [],
  );
}

export function useSovereignWalletDetails() {
  return useMemo<WalletDetails>(() => ({}), []);
}

export function useSovereignConnectFn(): () => void {
  return () => {};
}

export function useSovereignDisconnectFn(): () => Promise<void> {
  return () => Promise.resolve();
}

export function useSovereignActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  return useMemo<ActiveChainInfo>(() => {
    return {
      chainDisplayName: 'Sovereign Placeholder',
      chainName: 'sovereign',
    };
  }, []);
}

export function useSovereignTransactionFns(
  _multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const onSwitchNetwork = useCallback(async (_chainName: ChainName) => {}, []);

  const onSendTx = useCallback(
    async ({
      tx,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (tx.type !== ProviderType.Sovereign)
        throw new Error(`Unsupported tx type: ${tx.type}`);

      return { hash: 'signature', confirm: () => Promise.reject() };
    },
    [],
  );

  const onMultiSendTx = useCallback(
    async ({
      txs: _,
      chainName: __,
      activeChainName: ___,
    }: {
      txs: WarpTypedTransaction[];
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      throw new Error('Multi Transactions not supported on Sovereign');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    switchNetwork: onSwitchNetwork,
    sendMultiTransaction: onMultiSendTx,
  };
}

export function useSovereignWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: IToken, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for sovereign');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

