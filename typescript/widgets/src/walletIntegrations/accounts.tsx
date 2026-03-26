import { useMemo } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import {
  type Address,
  type KnownProtocolType,
  ProtocolType,
} from '@hyperlane-xyz/utils';

import { useAleoAccount } from './aleoWallet.js';
import { getAccountAddressForChain } from './accountUtils.js';
import { useCosmosAccount } from './cosmosWallet.js';
import { useEthereumAccount } from './ethereumWallet.js';
import { useRadixAccount } from './radixWallet.js';
import { useSolanaAccount } from './solanaWallet.js';
import { useStarknetAccount } from './starknetWallet.js';
import { type AccountInfo } from './types.js';
import { useTronAccount } from './tronWallet.js';

export function useAccounts(
  multiProvider: MinimalProviderRegistry,
  blacklistedAddresses: Address[] = [],
): {
  accounts: Record<KnownProtocolType, AccountInfo>;
  readyAccounts: Array<AccountInfo>;
} {
  const evmAccountInfo = useEthereumAccount(multiProvider);
  const solAccountInfo = useSolanaAccount(multiProvider);
  const cosmAccountInfo = useCosmosAccount(multiProvider);
  const starknetAccountInfo = useStarknetAccount(multiProvider);
  const radixAccountInfo = useRadixAccount(multiProvider);
  const aleoAccountInfo = useAleoAccount(multiProvider);
  const tronAccountInfo = useTronAccount(multiProvider);

  const readyAccounts = useMemo(
    () =>
      [
        evmAccountInfo,
        solAccountInfo,
        cosmAccountInfo,
        starknetAccountInfo,
        radixAccountInfo,
        aleoAccountInfo,
        tronAccountInfo,
      ].filter((a) => a.isReady),
    [
      evmAccountInfo,
      solAccountInfo,
      cosmAccountInfo,
      starknetAccountInfo,
      radixAccountInfo,
      aleoAccountInfo,
      tronAccountInfo,
    ],
  );

  const readyAddresses = readyAccounts
    .map((a) => a.addresses)
    .flat()
    .map((a) => a.address.toLowerCase());
  if (readyAddresses.some((a) => blacklistedAddresses.includes(a))) {
    throw new Error('Wallet address is blacklisted');
  }

  return useMemo(
    () => ({
      accounts: {
        [ProtocolType.Ethereum]: evmAccountInfo,
        [ProtocolType.Sealevel]: solAccountInfo,
        [ProtocolType.Cosmos]: cosmAccountInfo,
        [ProtocolType.CosmosNative]: cosmAccountInfo,
        [ProtocolType.Starknet]: starknetAccountInfo,
        [ProtocolType.Radix]: radixAccountInfo,
        [ProtocolType.Aleo]: aleoAccountInfo,
        [ProtocolType.Tron]: tronAccountInfo,
      },
      readyAccounts,
    }),
    [
      evmAccountInfo,
      solAccountInfo,
      cosmAccountInfo,
      starknetAccountInfo,
      radixAccountInfo,
      aleoAccountInfo,
      tronAccountInfo,
      readyAccounts,
    ],
  );
}

export function useAccountForChain(
  multiProvider: MinimalProviderRegistry,
  chainName?: ChainName,
): AccountInfo | undefined {
  const { accounts } = useAccounts(multiProvider);
  const protocol = chainName ? multiProvider.getProtocol(chainName) : undefined;
  if (!chainName || !protocol) return undefined;
  return accounts?.[protocol];
}

export function useAccountAddressForChain(
  multiProvider: MinimalProviderRegistry,
  chainName?: ChainName,
): Address | undefined {
  const { accounts } = useAccounts(multiProvider);
  return getAccountAddressForChain(multiProvider, chainName, accounts);
}
