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
import { ProtocolType, assert, retryAsync, sleep } from '@hyperlane-xyz/utils';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

// Lazy initialization to avoid SSR issues with browser-only APIs
let adapter: ShieldWalletAdapter | null = null;

function getAdapter(): ShieldWalletAdapter {
  if (!adapter) {
    if (typeof window === 'undefined') {
      throw new Error(
        'ShieldWalletAdapter requires a browser environment and cannot be used during server-side rendering',
      );
    }
    adapter = new ShieldWalletAdapter();
  }
  return adapter;
}

const MAX_POLLING_ATTEMPTS = 60;
const POLLING_DELAY_MS = 1000;

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const [account, setAccount] = useState(getAdapter().account);

  useEffect(() => {
    const adapterInstance = getAdapter();
    const handleAccountChange = () => {
      setAccount(adapterInstance.account);
    };

    adapterInstance.on('connect', handleAccountChange);
    adapterInstance.on('disconnect', handleAccountChange);

    handleAccountChange();

    return () => {
      adapterInstance.off('connect', handleAccountChange);
      adapterInstance.off('disconnect', handleAccountChange);
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
  const adapterInstance = getAdapter();
  const name = adapterInstance.name;
  const logoUrl = adapterInstance.icon;

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
    getAdapter().connect(Network.MAINNET, WalletDecryptPermission.AutoDecrypt, [
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
    await getAdapter().disconnect();
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

      const adapterInstance = getAdapter();
      const transactionResult = await adapterInstance.executeTransaction({
        program: transaction.programName,
        function: transaction.functionName,
        fee: Number(fee),
        inputs: transaction.inputs,
        privateFee: transaction.privateFee,
      });

      if (!transactionResult) {
        throw new Error(`Failed to execute Aleo transaction`);
      }

      let transactionStatus = '';
      let transactionHash = '';
      let attempts = 0;

      while (!transactionHash && attempts < MAX_POLLING_ATTEMPTS) {
        await sleep(POLLING_DELAY_MS);
        attempts++;

        try {
          const statusResponse = await retryAsync(() =>
            adapterInstance.transactionStatus(transactionResult.transactionId),
          );
          transactionStatus = statusResponse.status;

          if (statusResponse.status.toLowerCase() !== 'pending') {
            if (statusResponse.transactionId) {
              transactionHash = statusResponse.transactionId;
              break;
            }

            throw new Error(
              `got no transaction id from ${transactionResult.transactionId}`,
            );
          }
        } catch (err) {
          if (attempts >= MAX_POLLING_ATTEMPTS) {
            throw new Error(
              `Failed to get transaction status from ${transactionResult.transactionId} after ${MAX_POLLING_ATTEMPTS} attempts: ${err}`,
            );
          }
        }
      }

      if (!transactionHash) {
        throw new Error(
          `Transaction polling timeout after ${MAX_POLLING_ATTEMPTS} attempts (${(MAX_POLLING_ATTEMPTS * POLLING_DELAY_MS) / 1000}s) for ${transactionResult.transactionId}`,
        );
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          transactionStatus.toLowerCase() === 'accepted',
          `Aleo tx failed: ${transactionStatus}`,
        );

        return {
          type: tx.type as ProviderType.Aleo,
          receipt: {
            status: transactionStatus,
            type: '',
            index: 0n,
            transaction: {} as any,
            finalize: [],
            transactionHash,
          },
        };
      };
      return { hash: transactionHash, confirm };
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
