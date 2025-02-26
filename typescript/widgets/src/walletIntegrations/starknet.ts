import {
  useAccount,
  useConnect,
  useDisconnect,
  useNetwork,
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
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

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
  const { chain } = useNetwork();
  const { account } = useAccount();

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const chainId = multiProvider.getChainMetadata(chainName).chainId;
      const targetChainId = BigInt(chainId);

      if (chain?.id !== targetChainId) {
        throw new Error(
          'Network switching not supported by StarkNet wallets directly. Please switch networks in your wallet.',
        );
      }
    },
    [chain, multiProvider],
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

      try {
        const result = await account.execute([tx.transaction as Call]);
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
    [onSwitchNetwork, account],
  );

  return { sendTransaction: onSendTx, switchNetwork: onSwitchNetwork };
}

interface StarknetChainConfig {
  id: bigint;
  name: string;
  network: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
    address: string;
  };
  rpcUrls: {
    default: {
      http: string[];
    };
    public: {
      http: string[];
    };
  };
}

// Helper function to get Starknet chains from multiProvider
export function getStarknetChains(
  multiProvider: MultiProtocolProvider,
): StarknetChainConfig[] {
  return getChainsForProtocol(multiProvider, ProtocolType.Starknet).map(
    (chain) => ({
      id: BigInt(chain.chainId),
      name: chain.name,
      network: chain.name.toLowerCase(),
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        address:
          '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
      },
      rpcUrls: {
        default: {
          http: chain.rpcUrls.map((url) => url.toString()),
        },
        public: {
          http: chain.rpcUrls.map((url) => url.toString()),
        },
      },
    }),
  );
}
