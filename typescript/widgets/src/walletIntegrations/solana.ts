import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Connection } from '@solana/web3.js';
import { useCallback, useMemo } from 'react';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
} from './types.js';
import { findChainByRpcUrl } from './utils.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/solana' });

export function useSolanaAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { publicKey, connected, wallet } = useWallet();
  const isReady = !!(publicKey && wallet && connected);
  const address = publicKey?.toBase58();

  return useMemo<AccountInfo>(
    () => ({
      protocol: ProtocolType.Sealevel,
      addresses: address ? [{ address: address }] : [],
      isReady: isReady,
    }),
    [address, isReady],
  );
}

export function useSolanaWalletDetails() {
  const { wallet } = useWallet();
  const { name, icon } = wallet?.adapter || {};

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl: icon,
    }),
    [name, icon],
  );
}

export function useSolanaConnectFn(): () => void {
  const { setVisible } = useWalletModal();
  return useCallback(() => setVisible(true), [setVisible]);
}

export function useSolanaDisconnectFn(): () => Promise<void> {
  const { disconnect } = useWallet();
  return disconnect;
}

export function useSolanaActiveChain(
  multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  const { connection } = useConnection();
  const connectionEndpoint = connection?.rpcEndpoint;
  return useMemo<ActiveChainInfo>(() => {
    try {
      const hostname = new URL(connectionEndpoint).hostname;
      const metadata = findChainByRpcUrl(multiProvider, hostname);
      if (!metadata) return {};
      return {
        chainDisplayName: metadata.displayName,
        chainName: metadata.name,
      };
    } catch (error) {
      logger.warn('Error finding sol active chain', error);
      return {};
    }
  }, [connectionEndpoint, multiProvider]);
}

export function useSolanaTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { sendTransaction: sendSolTransaction } = useWallet();

  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    logger.warn(`Solana wallet must be connected to origin chain ${chainName}`);
  }, []);

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
        await onSwitchNetwork(chainName);
      const rpcUrl = multiProvider.getRpcUrl(chainName);
      const connection = new Connection(rpcUrl, 'confirmed');
      const {
        context: { slot: minContextSlot },
        value: { blockhash, lastValidBlockHeight },
      } = await connection.getLatestBlockhashAndContext();

      logger.debug(`Sending tx on chain ${chainName}`);
      const signature = await sendSolTransaction(tx.transaction, connection, {
        minContextSlot,
      });

      const confirm = (): Promise<TypedTransactionReceipt> =>
        connection
          .confirmTransaction({ blockhash, lastValidBlockHeight, signature })
          .then(() => connection.getTransaction(signature))
          .then((r) => ({
            type: ProviderType.SolanaWeb3,
            receipt: r!,
          }));

      return { hash: signature, confirm };
    },
    [onSwitchNetwork, sendSolTransaction, multiProvider],
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
    [onSwitchNetwork, sendSolTransaction, multiProvider],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork: onSwitchNetwork,
  };
}
