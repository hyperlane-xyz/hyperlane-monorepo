import { useWallet } from '@solana/wallet-adapter-react';
import { Connection } from '@solana/web3.js';
import { useCallback } from 'react';

import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';

import { widgetLogger } from '../logger.js';

import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/solana' });
export {
  useSolanaAccount,
  useSolanaActiveChain,
  useSolanaConnectFn,
  useSolanaDisconnectFn,
  useSolanaWalletDetails,
} from './solanaWallet.js';

export function useSolanaSwitchNetwork(): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    logger.warn(`Solana wallet must be connected to origin chain ${chainName}`);
  }, []);

  return { switchNetwork: onSwitchNetwork };
}

export function useSolanaWatchAsset(
  _multiProvider: MultiProviderAdapter,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for solana');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useSolanaTransactionFns(
  multiProvider: MultiProviderAdapter,
): ChainTransactionFns {
  const { sendTransaction: sendSolTransaction } = useWallet();
  const { switchNetwork } = useSolanaSwitchNetwork();

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (tx.type !== ProviderType.SolanaWeb3)
        throw new Error(`Unsupported tx type: ${tx.type}`);
      if (activeChainName && activeChainName !== chainName)
        await switchNetwork(chainName);
      const rpcUrl = multiProvider.getRpcUrl(chainName);
      const connection = new Connection(rpcUrl, 'confirmed');
      const {
        context: { slot: minContextSlot },
        value: { lastValidBlockHeight },
      } = await connection.getLatestBlockhashAndContext();

      logger.debug(`Sending tx on chain ${chainName}`);
      const signature = await sendSolTransaction(tx.transaction, connection, {
        minContextSlot,
      });

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        // Poll via HTTP instead of connection.confirmTransaction which
        // relies on signatureSubscribe (WebSocket) — many RPC providers
        // (e.g. Alchemy) don't support that method.
        const POLL_INTERVAL_MS = 2000;
        while (true) {
          try {
            const { value } = await connection.getSignatureStatuses([
              signature,
            ]);
            const status = value?.[0];
            if (status?.err) {
              throw new Error(
                `Transaction failed: ${JSON.stringify(status.err)}`,
              );
            }
            if (
              status?.confirmationStatus === 'confirmed' ||
              status?.confirmationStatus === 'finalized'
            ) {
              break;
            }
            const blockHeight = await connection.getBlockHeight();
            if (blockHeight > lastValidBlockHeight) {
              throw new Error('Transaction expired: block height exceeded');
            }
          } catch (error) {
            // Re-throw definitive failures (tx error, expiry)
            if (
              error instanceof Error &&
              (error.message.startsWith('Transaction failed') ||
                error.message.startsWith('Transaction expired'))
            ) {
              throw error;
            }
            // Tolerate transient RPC errors (timeouts, rate limits)
            logger.warn('Transient error polling tx confirmation', error);
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) {
          throw new Error(`Transaction ${signature} confirmed but not found`);
        }
        return { type: ProviderType.SolanaWeb3, receipt: tx };
      };

      return { hash: signature, confirm };
    },
    [switchNetwork, sendSolTransaction, multiProvider],
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
      throw new Error('Multi Transactions not supported on Solana');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
