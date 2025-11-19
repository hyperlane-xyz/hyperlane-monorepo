import { useCallback, useMemo } from 'react';

import { ChainName, IToken, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

export function useAleoAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const publicKey = '';

  return {
    protocol: ProtocolType.Aleo,
    addresses: [
      {
        address: publicKey || '',
        chainName: 'Aleo',
      },
    ],
    publicKey: undefined, // we don't need the public key for aleo
    isReady: !!publicKey,
  };
}

export function useAleoWalletDetails() {
  const name = 'Leo Wallet';
  const logoUrl =
    'https://cdn.prod.website-files.com/6559a97a91ac8fe073763dc8/656ef23110a6ecf0a7e2cf64_logo.svg';

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useAleoConnectFn(): () => void {
  return () => {
    console.log('connect');
  };
}

export function useAleoDisconnectFn(): () => Promise<void> {
  return async () => {
    console.log('disconnect');
  };
}

export function useAleoActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Aleo doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useAleoSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      // Aleo does not have switch capability
      throw new Error(
        `Aleo wallet must be connected to origin chain ${displayName}`,
      );
    },
    [multiProvider],
  );

  return { switchNetwork: onSwitchNetwork };
}

export function useAleoWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: IToken, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Aleo');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useAleoTransactionFns(
  _multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  return {} as any;
}
