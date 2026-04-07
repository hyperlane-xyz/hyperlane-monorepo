import { cosmoshub } from '@hyperlane-xyz/registry';
import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import {
  type Address,
  type HexString,
  type KnownProtocolType,
  ProtocolType,
} from '@hyperlane-xyz/utils';

import type { AccountInfo } from './types.js';

export function getAccountAddressForChain(
  multiProvider: MinimalProviderRegistry,
  chainName?: ChainName,
  accounts?: Record<KnownProtocolType, AccountInfo>,
): Address | undefined {
  if (!chainName || !accounts) return undefined;
  const protocol = multiProvider.getProtocol(chainName);
  const account = accounts[protocol];
  if (
    protocol === ProtocolType.Cosmos ||
    protocol === ProtocolType.CosmosNative
  ) {
    return account?.addresses.find((a) => a.chainName === chainName)?.address;
  } else {
    // Use first because only cosmos has the notion of per-chain addresses
    return account?.addresses[0]?.address;
  }
}

export function getAddressFromAccountAndChain(
  account?: AccountInfo,
  chainName?: ChainName,
) {
  if (!account) {
    return 'Unknown';
  }

  // only in cosmos there are multiple addresses per account, in this
  // case we display the cosmos hub address by default. If the user
  // selects a cosmos based origin chain in the swap form that cosmos
  // address is displayed instead
  if (
    account.protocol === ProtocolType.Cosmos ||
    account.protocol === ProtocolType.CosmosNative
  ) {
    // chainName can be an EVM chain here, therefore if no
    // cosmos address was found we search for the cosmos hub
    // address below
    const cosmosAddress = account?.addresses?.find(
      (a) => a.chainName === chainName,
    )?.address;

    // if no cosmos address was found for the chain name we search
    // for the cosmos hub address as fallback
    return (
      cosmosAddress ??
      account?.addresses?.find((a) => a.chainName === cosmoshub.name)
        ?.address ??
      'Unknown'
    );
  }

  // by default display the first address of the account
  return account.addresses[0]?.address ?? 'Unknown';
}

export function getAccountAddressAndPubKey(
  multiProvider: MinimalProviderRegistry,
  chainName?: ChainName,
  accounts?: Record<KnownProtocolType, AccountInfo>,
): { address?: Address; publicKey?: Promise<HexString> } {
  const address = getAccountAddressForChain(multiProvider, chainName, accounts);
  if (!accounts || !chainName || !address) return {};
  const protocol = multiProvider.getProtocol(chainName);
  const publicKey = accounts[protocol]?.publicKey;
  return { address, publicKey };
}
