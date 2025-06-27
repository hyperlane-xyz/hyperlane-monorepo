import { Chain } from '@starknet-react/chains';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useNetwork,
  useSendTransaction,
  useSwitchChain,
} from '@starknet-react/core';
import { useCallback, useMemo } from 'react';
import { Call } from 'starknet';
import { StarknetkitConnector, useStarknetkitConnectModal } from 'starknetkit';

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

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/starknet',
});

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

  // This is how they do it: https://github.com/argentlabs/starknetkit-example-dapp/blob/d1d5ba8b5e06eef76b9df9b01832b57d2f22c649/src/components/connect/ConnectStarknetReactNext.tsx#L21
  const { starknetkitConnectModal } = useStarknetkitConnectModal({
    connectors: connectors as StarknetkitConnector[],
  });

  return useCallback(async () => {
    const { connector } = await starknetkitConnectModal();
    if (connector) {
      await connectAsync({ connector });
    } else {
      logger.error('No Starknet wallet connectors available');
    }
  }, [connectAsync, starknetkitConnectModal]);
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
      if (txs.some((tx) => tx.type !== ProviderType.Starknet)) {
        throw new Error(
          `Invalid transaction type in Starknet transactions: ${txs.map((tx) => tx.type).join(',')}`,
        );
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

        const result = await sendAsync(txs.map((tx) => tx.transaction as Call));
        const hash = result.transaction_hash;
        const confirm = async (): Promise<TypedTransactionReceipt[]> => {
          const receipt = await account.waitForTransaction(hash);
          return [
            {
              type: ProviderType.Starknet,
              hash,
              receipt,
            },
          ];
        };

        return { confirm };
      } catch (error) {
        logger.error('Failed to send StarkNet transactions:', error);
        throw error;
      }
    },
    [account, multiProvider, onSwitchNetwork, sendAsync],
  );

  return {
    sendTransactions: onSendTxs,
    switchNetwork: onSwitchNetwork,
  };
}

export function getStarknetChains(
  multiProvider: MultiProtocolProvider,
): Chain[] {
  return getChainsForProtocol(multiProvider, ProtocolType.Starknet).map(
    chainMetadataToStarknetChain,
  );
}
