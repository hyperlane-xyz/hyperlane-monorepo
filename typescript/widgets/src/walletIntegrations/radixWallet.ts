import {
  DataRequestBuilder,
  generateRolaChallenge,
} from '@radixdlt/radix-dapp-toolkit';
import { useMemo } from 'react';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { useAccount } from './radix/AccountContext.js';
import { usePopup } from './radix/RadixProviders.js';
import { useRdt } from './radix/hooks/useRdt.js';
import type { AccountInfo, ActiveChainInfo, WalletDetails } from './types.js';

export function useRadixAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { accounts } = useAccount();

  return {
    protocol: ProtocolType.Radix,
    addresses: accounts.map((account) => ({
      address: account.address,
    })),
    publicKey: undefined,
    isReady: !!accounts.length,
  };
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
  assert(rdt, `radix dapp toolkit not defined`);

  const popUp = usePopup();
  assert(popUp, `radix wallet popup not defined`);

  const { setAccounts } = useAccount();

  rdt.walletApi.provideChallengeGenerator(async () => generateRolaChallenge());

  return async () => {
    popUp.setShowPopUp(true);
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
    popUp.setShowPopUp(false);
  };
}

export function useRadixDisconnectFn(): () => Promise<void> {
  const rdt = useRdt();
  assert(rdt, `radix dapp toolkit not defined`);

  const { setAccounts } = useAccount();

  return async () => {
    rdt.disconnect();
    setAccounts([]);
  };
}

export function useRadixActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  return useMemo(() => ({}) as ActiveChainInfo, []);
}
