import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useCallback, useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';
import { findChainByRpcUrl } from './utils.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/solanaBase' });

export function useSolanaAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { publicKey, connected, wallet } = useWallet();
  const isReady = !!(publicKey && wallet && connected);
  const address = publicKey?.toBase58();

  return useMemo(
    () => ({
      protocol: ProtocolType.Sealevel,
      addresses: address ? [{ address }] : [],
      isReady,
    }),
    [address, isReady],
  );
}

export function useSolanaWalletDetails(): WalletDetails {
  const { wallet } = useWallet();
  const { name, icon } = wallet?.adapter || {};

  return useMemo(
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

  return useMemo(() => {
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
