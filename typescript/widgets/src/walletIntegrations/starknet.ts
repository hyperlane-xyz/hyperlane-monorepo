import { Chain } from '@starknet-react/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useNetwork,
  useSendTransaction,
  useSwitchChain,
} from '@starknet-react/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Call } from 'starknet';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
  chainMetadataToStarknetChain,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

interface StarknetKit {
  useStarknetkitConnectModal: () => {
    starknetkitConnectModal: (options?: any) => Promise<{
      connector?: any;
    }>;
  };
}

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/starknet',
});

export function useStarknetKit() {
  const [starknetkit, setStarknetkit] = useState<{
    useStarknetkitConnectModal?: any;
  }>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadStarknetkit = async () => {
      try {
        const starknetkit = (await import('starknetkit')) as StarknetKit;
        setStarknetkit({
          useStarknetkitConnectModal: starknetkit.useStarknetkitConnectModal,
        });
      } catch (error) {
        logger.error('Failed to load starknetkit:', error);
      } finally {
        setIsLoading(false);
      }
    };

    void loadStarknetkit();
  }, []);

  return { ...starknetkit, isLoading };
}

export function useStarknetAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { address, isConnected } = useAccount();

  return useMemo<AccountInfo>(
    () => ({
      protocol: ProtocolType.Starknet,
      addresses: address ? [{ address }] : [],
      isReady: !!isConnected,
    }),
    [address, isConnected],
  );
}

export function useStarknetWalletDetails(): WalletDetails {
  const { connector } = useAccount();

  return useMemo<WalletDetails>(
    () => ({
      name: connector?.id || 'Starknet Wallet',
      logoUrl:
        typeof connector?.icon === 'string'
          ? connector.icon
          : connector?.icon?.light,
    }),
    [connector],
  );
}

export function useStarknetConnectFn(): () => void {
  const { connectAsync, connectors } = useConnect();
  const { useStarknetkitConnectModal, isLoading } = useStarknetKit();

  // Store the modal function reference
  const modalRef = useRef<any>(null);

  // When the hook becomes available, update the reference
  useEffect(() => {
    if (!isLoading && useStarknetkitConnectModal) {
      // Just store the hook function itself
      modalRef.current = useStarknetkitConnectModal;
    }
  }, [isLoading, useStarknetkitConnectModal]);

  return useCallback(async () => {
    if (isLoading || !modalRef.current) {
      logger.warn('Starknet wallet not loaded yet');
      return;
    }

    // Now call the function to get the modal when needed
    const modal = modalRef.current({
      connectors: connectors as any[],
    }).starknetkitConnectModal;

    const { connector } = await modal();

    if (connector) {
      await connectAsync({ connector });
    } else {
      logger.error('No Starknet wallet connectors available');
    }
  }, [connectAsync, connectors, isLoading]);
}

export function useStarknetDisconnectFn(): () => Promise<void> {
  const { disconnectAsync } = useDisconnect();
  return disconnectAsync;
}

export function useStarknetActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  const { chain } = useNetwork();

  return useMemo<ActiveChainInfo>(
    () => ({
      chainDisplayName: chain?.name,
      chainName: chain?.id ? chain.id.toString() : undefined,
    }),
    [chain],
  );
}

export function useStarknetTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { account } = useAccount();

  const { sendAsync } = useSendTransaction({});
  const { switchChainAsync } = useSwitchChain({});

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const chainId = multiProvider.getChainMetadata(chainName).chainId;
      await switchChainAsync({
        chainId: chainId.toString(),
      });
    },
    [multiProvider, switchChainAsync],
  );

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
      if (tx.type !== ProviderType.Starknet) {
        throw new Error(`Invalid transaction type for Starknet: ${tx.type}`);
      }

      if (activeChainName && activeChainName !== chainName) {
        await onSwitchNetwork(chainName);
      }

      if (!account) {
        throw new Error('No StarkNet account connected');
      }

      const chainId = multiProvider.getChainMetadata(chainName).chainId;
      const chainIdFromWallet = await account.getChainId();

      try {
        assert(
          chainIdFromWallet === chainId,
          `Wallet not on chain ${chainName} (ChainMismatchError)`,
        );

        const result = await sendAsync([tx.transaction as Call]);
        const hash = result.transaction_hash;
        const confirm = async (): Promise<TypedTransactionReceipt> => {
          const receipt = await account.waitForTransaction(hash);
          return {
            type: ProviderType.Starknet,
            receipt,
          };
        };

        return { hash, confirm };
      } catch (error) {
        logger.error('Failed to send StarkNet transaction:', error);
        throw error;
      }
    },
    [account, multiProvider, onSwitchNetwork, sendAsync],
  );

  return { sendTransaction: onSendTx, switchNetwork: onSwitchNetwork };
}

export function getStarknetChains(
  multiProvider: MultiProtocolProvider,
): Chain[] {
  return getChainsForProtocol(multiProvider, ProtocolType.Starknet).map(
    chainMetadataToStarknetChain,
  );
}
