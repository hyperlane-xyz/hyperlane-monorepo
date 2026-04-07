import {
  useAccount,
  useConnect,
  useDisconnect,
  useNetwork,
} from '@starknet-react/core';
import { useCallback, useMemo } from 'react';
import { useStarknetkitConnectModal } from 'starknetkit';
import type { StarknetkitConnector } from 'starknetkit';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/starknetWallet',
});

type StarknetReactConnector = ReturnType<
  typeof useConnect
>['connectors'][number];

function toStarknetkitConnector(
  connector: StarknetReactConnector,
): StarknetkitConnector {
  const icon =
    typeof connector.icon === 'string'
      ? connector.icon
      : connector.icon
        ? {
            light: connector.icon.light,
            dark: connector.icon.dark,
          }
        : undefined;

  return {
    id: connector.id,
    name: connector.name,
    ...(icon ? { icon } : {}),
  };
}

export function useStarknetAccount(
  _multiProvider: MinimalProviderRegistry,
): AccountInfo {
  const { address, isConnected } = useAccount();

  return useMemo(
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

  return useMemo(
    () => ({
      name:
        connector?.id === 'argentX'
          ? 'Ready Wallet'
          : connector?.name || 'Starknet Wallet',
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
  const { starknetkitConnectModal } = useStarknetkitConnectModal({
    connectors: connectors.map(toStarknetkitConnector),
  });

  return useCallback(async () => {
    const { connector } = await starknetkitConnectModal();
    if (!connector) {
      logger.error('No Starknet wallet connectors available');
      return;
    }

    const selectedConnector = connectors.find((c) => c.id === connector.id);
    if (!selectedConnector) {
      logger.error(
        `Selected Starknet connector ${connector.id} is not registered with @starknet-react/core`,
      );
      return;
    }

    await connectAsync({ connector: selectedConnector });
  }, [connectAsync, connectors, starknetkitConnectModal]);
}

export function useStarknetDisconnectFn(): () => Promise<void> {
  const { disconnectAsync } = useDisconnect();
  return disconnectAsync;
}

export function useStarknetActiveChain(
  _multiProvider: MinimalProviderRegistry,
): ActiveChainInfo {
  const { chain } = useNetwork();

  return useMemo(
    () => ({
      chainDisplayName: chain?.name,
      chainName: chain?.id ? chain.id.toString() : undefined,
    }),
    [chain],
  );
}
