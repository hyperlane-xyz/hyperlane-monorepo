import {
  DataRequestBuilder,
  generateRolaChallenge,
} from '@radixdlt/radix-dapp-toolkit';
import { useCallback, useEffect, useMemo } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import { useAccount } from './radix/AccountContext.js';
import { usePopup } from './radix/RadixProviders.js';
import { useRdt } from './radix/hooks/useRdt.js';
import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';

const logger = widgetLogger.child({
  module: 'walletIntegrations/radixWallet',
});

export function useRadixAccount(
  _multiProvider: MinimalProviderRegistry,
): AccountInfo {
  const { accounts } = useAccount();

  return useMemo(
    () => ({
      protocol: ProtocolType.Radix,
      addresses: accounts.map((account) => ({
        address: account.address,
      })),
      publicKey: undefined,
      isReady: !!accounts.length,
    }),
    [accounts],
  );
}

export function useRadixWalletDetails(): WalletDetails {
  const name = 'Radix Wallet';
  const logoUrl =
    'https://raw.githubusercontent.com/radixdlt/radix-dapp-toolkit/refs/heads/main/docs/radix-logo.png';

  return useMemo(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useRadixConnectFn(): () => void {
  const rdt = useRdt();
  const popUp = usePopup();
  const { setAccounts } = useAccount();

  useEffect(() => {
    if (!rdt) return;
    rdt.walletApi.provideChallengeGenerator(async () =>
      generateRolaChallenge(),
    );
  }, [rdt]);

  return useCallback(() => {
    void (async () => {
      if (!rdt) {
        logger.warn('Radix dapp toolkit not defined');
        return;
      }
      if (!popUp) {
        logger.warn('Radix wallet popup not defined');
        return;
      }

      popUp.setShowPopUp(true);
      try {
        rdt.walletApi.setRequestData(
          DataRequestBuilder.accounts().exactly(1).reset(),
        );
        const result = await rdt.walletApi.sendRequest();
        if (result.isOk()) {
          setAccounts(
            result.value.accounts.map((p) => ({
              address: p.address,
            })),
          );
        }
      } finally {
        popUp.setShowPopUp(false);
      }
    })();
  }, [popUp, rdt, setAccounts]);
}

export function useRadixDisconnectFn(): () => Promise<void> {
  const rdt = useRdt();
  const { setAccounts } = useAccount();

  return useCallback(async () => {
    if (!rdt) {
      logger.warn('Radix dapp toolkit not defined');
      setAccounts([]);
      return;
    }
    rdt.disconnect();
    setAccounts([]);
  }, [rdt, setAccounts]);
}

export function useRadixActiveChain(
  _multiProvider: MinimalProviderRegistry,
): ActiveChainInfo {
  return useMemo(() => ({}) as ActiveChainInfo, []);
}
