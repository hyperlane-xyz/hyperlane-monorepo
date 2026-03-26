import { useWallet } from '@tronweb3/tronwallet-adapter-react-hooks';
import { TronLinkAdapterName } from '@tronweb3/tronwallet-adapter-tronlink';
import { useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  WalletDetails,
} from './types.js';

export function useTronAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { address, connected } = useWallet();

  return useMemo(() => {
    const addresses: Array<ChainAddress> = [];
    if (address) addresses.push({ address });

    return {
      protocol: ProtocolType.Tron,
      addresses,
      publicKey: undefined,
      isReady: connected && !!address,
    };
  }, [address, connected]);
}

export function useTronWalletDetails(): WalletDetails {
  const { wallet } = useWallet();
  const { icon, name } = wallet?.adapter || {};

  return useMemo(
    () => ({
      name,
      logoUrl: icon,
    }),
    [name, icon],
  );
}

export function useTronConnectFn(): () => void {
  const { connect, select } = useWallet();
  return async () => {
    select(TronLinkAdapterName);
    await connect();
  };
}

export function useTronDisconnectFn(): () => Promise<void> {
  const { disconnect } = useWallet();
  return disconnect;
}

export function useTronActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  return useMemo(() => ({}) as ActiveChainInfo, []);
}
