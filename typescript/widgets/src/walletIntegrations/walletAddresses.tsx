import { useMemo } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import { type KnownProtocolType, ProtocolType } from '@hyperlane-xyz/utils';

import { useAccounts } from './accounts.js';
import { type AccountInfo, type ChainAddress } from './types.js';

const WALLET_ADDRESS_PROTOCOLS: ReadonlyArray<KnownProtocolType> = [
  ProtocolType.Ethereum,
  ProtocolType.Sealevel,
  ProtocolType.Cosmos,
  ProtocolType.CosmosNative,
  ProtocolType.Starknet,
  ProtocolType.Radix,
  ProtocolType.Aleo,
  ProtocolType.Tron,
];

export function getAddressForChain(
  addresses: ChainAddress[] | undefined,
  protocol?: ProtocolType,
  chainName?: ChainName,
) {
  if (!addresses?.length) return undefined;
  const chainAddress = addresses.find(
    (address) => address.chainName === chainName,
  )?.address;
  if (
    protocol === ProtocolType.Cosmos ||
    protocol === ProtocolType.CosmosNative
  ) {
    return chainAddress;
  }
  // Intentional fallback: non-Cosmos wallets often reuse one address across chains.
  return chainAddress ?? addresses[0]?.address;
}

export function useWalletAddressesByProtocol(
  multiProvider: MinimalProviderRegistry,
): Map<ProtocolType, ChainAddress[]> {
  const { accounts } = useAccounts(multiProvider);

  return useMemo(() => {
    const map = new Map<ProtocolType, ChainAddress[]>();
    for (const protocol of WALLET_ADDRESS_PROTOCOLS) {
      const account: AccountInfo = accounts[protocol];
      if (!account.addresses.length) continue;
      map.set(protocol, account.addresses);
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
    return getAddressForChain(
      walletAddresses.get(protocol),
      protocol,
      chainName,
    );
  }, [chainName, protocol, walletAddresses]);
}
