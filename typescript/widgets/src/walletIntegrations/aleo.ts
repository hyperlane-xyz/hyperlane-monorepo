import { Network } from '@provablehq/aleo-types';
import { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield';
import { WalletDecryptPermission } from '@provablehq/aleo-wallet-standard';
import { useCallback, useEffect, useMemo, useState } from 'react';

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

const adapter = new ShieldWalletAdapter();

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const [account, setAccount] = useState(adapter.account);

  useEffect(() => {
    const handleAccountChange = () => {
      setAccount(adapter.account);
    };

    adapter.on('connect', () => {
      setAccount(adapter.account);
    });

    adapter.on('disconnect', () => {
      setAccount(adapter.account);
    });

    handleAccountChange();

    return () => {
      adapter.off('connect', handleAccountChange);
      adapter.off('disconnect', handleAccountChange);
    };
  }, []);

  return {
    protocol: ProtocolType.Aleo,
    addresses: account
      ? [
          {
            address: account.address ?? '',
            chainName: 'Aleo',
          },
        ]
      : [],
    publicKey: undefined, // we don't need the public key for aleo
    isReady: !!account,
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
    adapter.connect(Network.MAINNET, WalletDecryptPermission.AutoDecrypt, [
      'hyp_multisig_core.aleo',
      'hyp_mailbox.aleo',
      'hyp_ism_manager.aleo',
      'hyp_hook_manager.aleo',
      'hyp_dispatch_proxy.aleo',
      'hyp_validator_announce.aleo',
      'hyp_warp_token_btc.aleo',
      'hyp_warp_token_eth.aleo',
      'hyp_warp_token_sol.aleo',
      'hyp_warp_token_usdt.aleo',
      'hyp_warp_token_usdc.aleo',
      'hyp_warp_token_credits.aleo',
    ]);
  };
}

export function useAleoDisconnectFn(): () => Promise<void> {
  return async () => {
    await adapter.disconnect();
  };
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
