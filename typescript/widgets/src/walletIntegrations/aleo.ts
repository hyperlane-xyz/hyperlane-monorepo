import { Network } from '@provablehq/aleo-types';
import { GalileoWalletAdapter } from '@provablehq/aleo-wallet-adaptor-prove-alpha';
import { WalletDecryptPermission } from '@provablehq/aleo-wallet-standard';
import { useCallback, useMemo } from 'react';

import { AleoTransaction } from '@hyperlane-xyz/aleo-sdk';
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

const adapter = new GalileoWalletAdapter();

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  return {
    protocol: ProtocolType.Aleo,
    addresses: [
      {
        address: adapter.account?.address ?? '',
        chainName: 'Aleo',
      },
    ],
    publicKey: undefined, // we don't need the public key for aleo
    isReady: !!adapter.account,
  };
}

export function useAleoWalletDetails() {
  const name = adapter.name;
  const logoUrl = adapter.icon;

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useAleoConnectFn(): () => void {
  return () => {
    adapter.connect(Network.TESTNET3, WalletDecryptPermission.AutoDecrypt, [
      'credits.aleo',
      'test_ism_manager.aleo',
      'test_mailbox.aleo',
      'test_hook_manager.aleo',
      'test_dispatch_proxy.aleo',
      'token_registry.aleo',
      'test_hyp_native.aleo',
    ]);
  };
}

export function useAleoDisconnectFn(): () => Promise<void> {
  return adapter.disconnect;
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
  const { switchNetwork } = useAleoSwitchNetwork(multiProvider);

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName: __,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      const transaction = tx.transaction as AleoTransaction;

      const provider = multiProvider.getAleoProvider(chainName);
      const { fee } = await provider.estimateTransactionFee({
        transaction,
      });

      const transactionResult = await adapter.executeTransaction({
        program: transaction.programName,
        function: transaction.functionName,
        fee: Number(fee),
        inputs: transaction.inputs,
        privateFee: transaction.privateFee,
      });

      if (!transactionResult) {
        throw new Error(`Failed to execute Aleo transaction`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          transactionResult.transactionId,
          `Aleo tx failed: ${transactionResult}`,
        );

        // TODO: populate receipt
        return {
          type: tx.type as ProviderType.Aleo,
          receipt: {
            status: '',
            type: '',
            index: 0n,
            transaction: {} as any,
            finalize: [],
            transactionHash: transactionResult.transactionId || '',
          },
        };
      };
      return { hash: transactionResult.transactionId || '', confirm };
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
