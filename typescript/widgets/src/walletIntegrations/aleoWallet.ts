import type { ShieldWalletAdapter } from '@provablehq/aleo-wallet-adaptor-shield';
import { WalletDecryptPermission } from '@provablehq/aleo-wallet-standard';
import { useEffect, useMemo, useState } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import { useAleoPopup } from './aleo/AleoProviders.js';
import { getAdapter, getAleoNetwork, onAdapterCreated } from './aleo/utils.js';
import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/aleoWallet',
});

export function useAleoAccount(
  _multiProvider: MinimalProviderRegistry,
): AccountInfo {
  const [account, setAccount] =
    useState<ShieldWalletAdapter['account']>(undefined);

  useEffect(() => {
    let removeAdapterListeners: (() => void) | undefined;
    const unsubscribe = onAdapterCreated((adapterInstance) => {
      const handleAccountChange = () => {
        setAccount(adapterInstance.account);
      };
      const handleAccountSwitched = async () => {
        try {
          await adapterInstance.connect(
            getAleoNetwork(),
            WalletDecryptPermission.AutoDecrypt,
            [],
          );
        } catch (error: unknown) {
          logger.error('Failed to reconnect after Aleo account switch', {
            error,
          });
        }
      };

      adapterInstance.on('connect', handleAccountChange);
      adapterInstance.on('disconnect', handleAccountChange);
      adapterInstance.on('accountChange', handleAccountSwitched);
      handleAccountChange();
      removeAdapterListeners = () => {
        adapterInstance.off('connect', handleAccountChange);
        adapterInstance.off('disconnect', handleAccountChange);
        adapterInstance.off('accountChange', handleAccountSwitched);
      };
    });
    return () => {
      unsubscribe();
      removeAdapterListeners?.();
    };
  }, []);

  return {
    protocol: ProtocolType.Aleo,
    addresses: account?.address
      ? [
          {
            address: account.address,
            chainName: 'Aleo',
          },
        ]
      : [],
    publicKey: undefined,
    isReady: !!account?.address,
  };
}

export function useAleoWalletDetails(): WalletDetails {
  const [details, setDetails] = useState<WalletDetails>({
    name: undefined,
    logoUrl: undefined,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return onAdapterCreated((adapterInstance) => {
      setDetails({
        name: adapterInstance.name,
        logoUrl: adapterInstance.icon,
      });
    });
  }, []);

  return details;
}

export function useAleoConnectFn(): () => void {
  const popUp = useAleoPopup();
  assert(
    popUp,
    `AleoPopupProvider is not defined, make sure it is imported and wrapping your application`,
  );

  return () => {
    popUp.setShowPopUp(true);
  };
}

export function useAleoDisconnectFn(): () => Promise<void> {
  return async () => {
    const adapter = await getAdapter();
    await adapter.disconnect();
  };
}

export function useAleoActiveChain(
  _multiProvider: MinimalProviderRegistry,
): ActiveChainInfo {
  return useMemo<ActiveChainInfo>(() => ({}), []);
}
