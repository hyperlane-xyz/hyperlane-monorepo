import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useCallback, useMemo } from 'react';
import { useAccount, useDisconnect } from 'wagmi';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';

export function useEthereumAccount(
  _multiProvider: MinimalProviderRegistry,
): AccountInfo {
  const { address, isConnected, connector } = useAccount();
  const isReady = !!(address && isConnected && connector);

  return useMemo<AccountInfo>(
    () => ({
      protocol: ProtocolType.Ethereum,
      addresses: address ? [{ address: `${address}` }] : [],
      isReady,
    }),
    [address, isReady],
  );
}

export function useEthereumWalletDetails(): WalletDetails {
  const { connector } = useAccount();
  const name = connector?.name;
  const logoUrl = connector?.icon;

  return useMemo(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useEthereumConnectFn(): () => void {
  const { openConnectModal } = useConnectModal();
  return useCallback(() => openConnectModal?.(), [openConnectModal]);
}

export function useEthereumDisconnectFn(): () => Promise<void> {
  const { disconnectAsync } = useDisconnect();
  return disconnectAsync;
}

export function useEthereumActiveChain(
  multiProvider: MinimalProviderRegistry,
): ActiveChainInfo {
  const { chain } = useAccount();
  return useMemo(
    () => ({
      chainDisplayName: chain?.name,
      chainName: chain
        ? multiProvider.tryGetChainMetadata(chain.id)?.name
        : undefined,
    }),
    [chain, multiProvider],
  );
}
