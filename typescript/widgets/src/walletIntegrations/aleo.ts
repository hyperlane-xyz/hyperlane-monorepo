import {
  EventType,
  Network,
  requestCreateEvent,
  useAccount,
  useConnect,
  useDisconnect,
} from '@puzzlehq/sdk';
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

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { account } = useAccount();
  return {
    protocol: ProtocolType.Aleo,
    addresses: [
      {
        address: account?.address ?? '',
        chainName: 'Aleo',
      },
    ],
    publicKey: undefined, // we don't need the public key for aleo
    isReady: !!account,
  };
}

export function useAleoWalletDetails() {
  const name = 'Puzzle Wallet';
  const logoUrl = 'https://docs.puzzle.online/_astro/icon.CnSbKTxP.png';

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useAleoConnectFn(): () => void {
  const { connect } = useConnect({
    dAppInfo: {
      name: '<YOUR DAPP NAME>',
      description: '<YOUR DAPP DESCRIPTION>',
      iconUrl: '<YOUR DAPP ICON URL>',
    },
    permissions: {
      programIds: {
        [Network.AleoMainnet]: [
          'dapp_1.aleo',
          'dapp_2.aleo',
          'dapp_2_imports.aleo',
        ],
        [Network.AleoTestnet]: [
          'dapp_3.aleo',
          'dapp_3_imports_1.aleo',
          'dapp_3_imports_2.aleo',
        ],
      },
    },
  });

  return connect;
}

export function useAleoDisconnectFn(): () => Promise<void> {
  const { disconnect } = useDisconnect();
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

      const createEventResponse = await requestCreateEvent({
        type: EventType.Execute,
        programId: transaction.programName,
        functionId: transaction.functionName,
        fee: Number(fee),
        inputs: transaction.inputs,
      });

      if (!createEventResponse) {
        throw new Error(`Failed to execute Aleo transaction`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          createEventResponse.eventId,
          `Aleo tx failed: ${createEventResponse}`,
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
            transactionHash: createEventResponse.eventId || '',
          },
        };
      };
      return { hash: createEventResponse.eventId || '', confirm };
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
