import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Connection, Transaction } from '@solana/web3.js';
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
  const { sendTransaction: sendSolTransaction, signAllTransactions } =
    useWallet();

  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    logger.warn(`Solana wallet must be connected to origin chain ${chainName}`);
  }, []);

  const onSendTxs = useCallback(
    async ({
      txs,
      chainName,
      activeChainName,
    }: {
      txs: WarpTypedTransaction[];
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (txs.some((tx) => tx.type !== ProviderType.SolanaWeb3)) {
        throw new Error(
          `Invalid transaction type in Solana transactions: ${txs.map((tx) => tx.type).join(',')}`,
        );
      }

      if (activeChainName && activeChainName !== chainName)
        await onSwitchNetwork(chainName);

      const rpcUrl = multiProvider.getRpcUrl(chainName);
      const connection = new Connection(rpcUrl, 'confirmed');

      logger.debug(`Sending tx on chain ${chainName}`);
      const signedTxs = await signAllTransactions!(
        txs.map((tx) => tx.transaction as Transaction),
      );

      const signatures = await Promise.all(
        signedTxs.map((tx) =>
          connection.sendEncodedTransaction(
            Buffer.from(tx.serialize().buffer).toString('base64'),
          ),
        ),
      );

      const confirm = (): Promise<TypedTransactionReceipt[]> =>
        Promise.all(
          signatures.map(async (signature) => {
            await connection.confirmTransaction(signature);
            const receipt = await connection.getTransaction(signature);
            return {
              type: ProviderType.SolanaWeb3,
              hash: signature,
              receipt: receipt!,
            };
          }),
        );

      return { confirm };
    },
    [onSwitchNetwork, sendSolTransaction, multiProvider],
  );

  return {
    sendTransactions: onSendTxs,
    switchNetwork: onSwitchNetwork,
  };
}
