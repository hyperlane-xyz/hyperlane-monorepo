import { useCallback } from 'react';

import type { AleoTransaction } from '@hyperlane-xyz/aleo-sdk/runtime';
import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';
import { assert, retryAsync, sleep } from '@hyperlane-xyz/utils';

import { getAdapter } from './aleo/utils.js';
import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';

const MAX_POLLING_ATTEMPTS = 60;
const POLLING_DELAY_MS = 1000;
export {
  useAleoAccount,
  useAleoActiveChain,
  useAleoConnectFn,
  useAleoDisconnectFn,
  useAleoWalletDetails,
} from './aleoWallet.js';

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
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
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
    [multiProvider],
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
