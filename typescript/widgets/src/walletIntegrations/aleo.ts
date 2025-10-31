import {
  DecryptPermission,
  Transaction,
  WalletAdapterNetwork,
  WalletNotConnectedError,
} from '@demox-labs/aleo-wallet-adapter-base';
import { useWallet } from '@demox-labs/aleo-wallet-adapter-react';
import { useCallback, useMemo } from 'react';

import { AleoTransaction as AleoSDKTransaction } from '@hyperlane-xyz/aleo-sdk';
import {
  ChainName,
  IToken,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { publicKey } = useWallet();

  return {
    protocol: ProtocolType.Aleo,
    addresses: [
      {
        address: publicKey || '',
        chainName: 'Aleo',
      },
    ],
    publicKey: undefined, // we don't need the public key for aleo
    isReady: !!publicKey,
  };
}

export function useAleoWalletDetails() {
  const name = 'Leo Wallet';
  const logoUrl =
    'https://cdn.prod.website-files.com/6559a97a91ac8fe073763dc8/656ef23110a6ecf0a7e2cf64_logo.svg';

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useAleoConnectFn(): () => void {
  const { connect } = useWallet();

  return () => {
    connect(DecryptPermission.NoDecrypt, WalletAdapterNetwork.MainnetBeta);
  };
}

export function useAleoDisconnectFn(): () => Promise<void> {
  const { disconnect } = useWallet();

  return disconnect;
}

export function useAleoActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Aleo doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useAleoSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      // Aleo does not have switch capability
      throw new Error(
        `Aleo wallet must be connected to origin chain ${displayName}`,
      );
    },
    [multiProvider],
  );

  return { switchNetwork: onSwitchNetwork };
}

export function useAleoWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: IToken, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Aleo');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useAleoTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { publicKey, requestTransaction, transactionStatus } = useWallet();
  const { switchNetwork } = useAleoSwitchNetwork(multiProvider);

  const onSendTx = useCallback(
    async ({
      tx,
      chainName: _,
      activeChainName: __,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (!publicKey) throw new WalletNotConnectedError();

      const transaction = tx.transaction as AleoSDKTransaction;

      const aleoTransaction = Transaction.createTransaction(
        publicKey,
        WalletAdapterNetwork.MainnetBeta,
        transaction.programName,
        transaction.functionName,
        transaction.inputs,
        transaction.priorityFee,
        transaction.privateFee,
      );

      assert(requestTransaction, `requestTransaction not defined`);
      const transactionId = await requestTransaction(aleoTransaction);

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(transactionStatus, `transactionStatus not defined`);
        const status = await transactionStatus(transactionId);
        console.log('status', status);

        return {
          type: tx.type as ProviderType.Aleo,
          receipt: {
            transactionHash: '',
          } as any,
        };
      };
      return { hash: '', confirm };
    },
    [switchNetwork],
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
      throw new Error('Multi Transactions not supported on Aleo');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
