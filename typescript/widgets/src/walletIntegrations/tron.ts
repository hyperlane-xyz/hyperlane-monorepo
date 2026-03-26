import { useWallet } from '@tronweb3/tronwallet-adapter-react-hooks';
import { useCallback } from 'react';

import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';

import {
  TronJsonRpcProvider,
  TronTransactionBuilder,
  TronTransactionResponse,
} from '@hyperlane-xyz/tron-sdk/runtime';

import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';
export {
  useTronAccount,
  useTronActiveChain,
  useTronConnectFn,
  useTronDisconnectFn,
  useTronWalletDetails,
} from './tronWallet.js';

export function useTronSwitchNetwork(
  _multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    // Most Tron wallets (like TronLink) don't support programmatic
    // network switching via a DApp standard like EIP-3326.
    throw new Error(
      `Please manually switch your Tron wallet to ${chainName} (Mainnet/Nile/Shasta)`,
    );
  }, []);

  return { switchNetwork: onSwitchNetwork };
}

export function useTronWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Tron');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

/**
 * Core Transaction Functionality for Tron.
 */
export function useTronTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { address, signTransaction, connected } = useWallet();
  const { switchNetwork } = useTronSwitchNetwork(multiProvider);

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName: _,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (!connected || !address) throw new Error(`Tron wallet not connected`);

      const provider = multiProvider.getProvider(chainName);

      let txID: string;
      let response: TronTransactionResponse;

      if (
        tx.type === ProviderType.Tron &&
        provider.type === ProviderType.Tron
      ) {
        const ethersTx = tx.transaction;
        let tronWebUrl = (provider.provider as TronJsonRpcProvider).host;
        // Remove /jsonrpc suffix if present, as TronTransactionBuilder expects the base URL
        tronWebUrl = tronWebUrl.replace('/jsonrpc', '');
        const txBuilder = new TronTransactionBuilder(tronWebUrl, address);
        const tronTx = await txBuilder.buildTransaction(ethersTx);

        const signedTransaction = await signTransaction(tronTx);
        const result =
          await txBuilder.trx.sendRawTransaction(signedTransaction);
        if (!result.result) {
          throw new Error(`Tron broadcast failed: ${JSON.stringify(result)}`);
        }
        txID = result.txid;
        response = txBuilder.getTransactionResponse(
          tx.transaction,
          tronTx,
          txID,
        );
      } else {
        throw new Error(`Invalid Tron provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        const receipt = await response.wait(1);

        return {
          type: tx.type,
          receipt,
        };
      };

      return { hash: txID, confirm };
    },
    [address, connected, signTransaction, multiProvider],
  );

  const onMultiSendTx = useCallback(async () => {
    throw new Error('Multi Transactions not supported on Tron');
  }, []);

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
