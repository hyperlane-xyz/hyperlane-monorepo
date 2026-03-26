import { useCallback } from 'react';

import type { RadixSDKTransaction } from '@hyperlane-xyz/radix-sdk/runtime';
import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';
import { assert, retryAsync } from '@hyperlane-xyz/utils';

import { useGatewayApi } from './radix/hooks/useGatewayApi.js';
import { useRdt } from './radix/hooks/useRdt.js';
import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';
export {
  useRadixAccount,
  useRadixActiveChain,
  useRadixConnectFn,
  useRadixDisconnectFn,
  useRadixWalletDetails,
} from './radixWallet.js';

export function useRadixSwitchNetwork(
  multiProvider: MultiProviderAdapter,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      // Radix does not have switch capability
      throw new Error(
        `Radix wallet must be connected to origin chain ${displayName}`,
      );
    },
    [multiProvider],
  );

  return { switchNetwork: onSwitchNetwork };
}

export function useRadixWatchAsset(
  _multiProvider: MultiProviderAdapter,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Radix');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useRadixTransactionFns(
  multiProvider: MultiProviderAdapter,
): ChainTransactionFns {
  const rdt = useRdt();
  const gatewayApi = useGatewayApi();
  const { switchNetwork } = useRadixSwitchNetwork(multiProvider);

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
      assert(rdt, `radix dapp toolkit is not defined`);
      assert(gatewayApi, `gateway api is not defined`);

      const transaction = tx.transaction as RadixSDKTransaction;
      assert(
        typeof transaction.manifest === 'string',
        `transaction manifests needs to be a string`,
      );

      const transactionResult = await rdt.walletApi.sendTransaction({
        transactionManifest: transaction.manifest,
        version: 1,
      });

      if (transactionResult.isErr()) {
        throw new Error(String(transactionResult.error), {
          cause: transactionResult.error,
        });
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          transactionResult.isOk(),
          `Radix tx failed: ${transactionResult}`,
        );

        const receipt = await retryAsync(
          () =>
            gatewayApi.transaction.getCommittedDetails(
              transactionResult.value.transactionIntentHash,
            ),
          5,
          5000,
        );

        return {
          type: tx.type as ProviderType.Radix,
          receipt: {
            ...receipt,
            transactionHash: transactionResult.value.transactionIntentHash,
          },
        };
      };
      return { hash: transactionResult.value.transactionIntentHash, confirm };
    },
    [rdt, gatewayApi],
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
      throw new Error('Multi Transactions not supported on Radix');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
