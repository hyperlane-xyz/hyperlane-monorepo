import { useChain, useChains } from '@cosmos-kit/react';
import { useMemo } from 'react';

import { cosmoshub } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import { HexString, ProtocolType } from '@hyperlane-xyz/utils';

import type {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  WalletDetails,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

const PLACEHOLDER_COSMOS_CHAIN = cosmoshub.name;

export function useCosmosAccount(
  multiProvider: MultiProtocolProvider,
): AccountInfo {
  const cosmosChains = getCosmosChainNames(multiProvider);
  const chainToContext = useChains(cosmosChains);

  return useMemo(() => {
    const addresses: Array<ChainAddress> = [];
    let publicKey: Promise<HexString> | undefined;
    let isReady = false;

    for (const [chainName, context] of Object.entries(chainToContext)) {
      if (!context.address) continue;
      addresses.push({ address: context.address, chainName });
      publicKey = context
        .getAccount()
        .then((acc) => Buffer.from(acc.pubkey).toString('hex'));
      isReady = true;
    }

    return {
      protocol: ProtocolType.Cosmos,
      addresses,
      publicKey,
      isReady,
    };
  }, [chainToContext]);
}

export function useCosmosWalletDetails(): WalletDetails {
  const { wallet } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const { logo, prettyName } = wallet || {};

  return useMemo(
    () => ({
      name: prettyName,
      logoUrl: typeof logo === 'string' ? logo : undefined,
    }),
    [prettyName, logo],
  );
}

export function useCosmosConnectFn(): () => void {
  const { openView } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  return openView;
}

export function useCosmosDisconnectFn(): () => Promise<void> {
  const { disconnect, address } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  return async () => {
    if (address) await disconnect();
  };
}

export function useCosmosActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function getCosmosChains(
  multiProvider: MultiProtocolProvider,
): ChainMetadata[] {
  return [
    ...getChainsForProtocol(multiProvider, ProtocolType.Cosmos),
    ...getChainsForProtocol(multiProvider, ProtocolType.CosmosNative),
    cosmoshub,
  ];
}

export function getCosmosChainNames(
  multiProvider: MultiProtocolProvider,
): ChainName[] {
  return getCosmosChains(multiProvider).map((c) => c.name);
}
