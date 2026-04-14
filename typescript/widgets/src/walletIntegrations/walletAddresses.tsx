import { useMemo } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAccounts } from './accounts.js';
import { type AccountInfo, type ChainAddress } from './types.js';

export function getAddressForChain(
  addresses: ChainAddress[] | undefined,
  chainName?: ChainName,
) {
  if (!addresses?.length) return undefined;
  // Intentional fallback: same-protocol wallets often reuse one address across chains.
  // Callers should filter by protocol before using this helper.
  return (
    addresses.find((address) => address.chainName === chainName)?.address ??
    addresses[0]?.address
  );
}

export function useWalletAddressesByProtocol(
  multiProvider: MinimalProviderRegistry,
): Map<ProtocolType, ChainAddress[]> {
  const { accounts } = useAccounts(multiProvider);

  return useMemo(() => {
    const map = new Map<ProtocolType, ChainAddress[]>();
    for (const [protocol, account] of Object.entries(accounts) as Array<
      [KnownProtocolType, AccountInfo]
    >) {
      if (!account.addresses.length) continue;
      map.set(protocol, account.addresses);
      if (protocol === ProtocolType.Cosmos) {
        map.set(ProtocolType.CosmosNative, account.addresses);
      }
    }
    return map;
  }, [accounts]);
}

export function useWalletAddressForChainAndProtocol(
  multiProvider: MinimalProviderRegistry,
  chainName?: ChainName,
  protocol?: ProtocolType,
) {
  const walletAddresses = useWalletAddressesByProtocol(multiProvider);
  return useMemo(() => {
    if (!chainName || !protocol) return undefined;
    return getAddressForChain(walletAddresses.get(protocol), chainName);
  }, [chainName, protocol, walletAddresses]);
}
