import { useChain, useChains } from '@cosmos-kit/react';
import { useMemo } from 'react';

import { cosmoshub } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk/metadata/chainMetadataTypes';
import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import { HexString, ProtocolType, ensure0x } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import type {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  WalletDetails,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

const PLACEHOLDER_COSMOS_CHAIN = cosmoshub.name;
const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/cosmosWallet',
});

function toHexString(bytes: Uint8Array): HexString {
  return ensure0x(
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}

export function useCosmosAccount(
  multiProvider: MinimalProviderRegistry,
): AccountInfo {
  const cosmosChains = getCosmosChainNames(multiProvider);
  const chainToContext = useChains(cosmosChains);

  return useMemo(() => {
    const addresses: Array<ChainAddress> = [];
    let publicKey: Promise<HexString | undefined> | undefined;
    let isReady = false;

    for (const [chainName, context] of Object.entries(chainToContext)) {
      if (!context.address) continue;
      addresses.push({ address: context.address, chainName });
      // Keep the most recently connected chain's public key.
      publicKey = context.getAccount().then(
        (acc) => toHexString(acc.pubkey),
        (error) => {
          logger.error('Failed to get Cosmos account public key', { error });
          return undefined;
        },
      );
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
  _multiProvider: MinimalProviderRegistry,
): ActiveChainInfo {
  // CosmosKit doesn't have the concept of an active chain;
  // wallets connect to each chain independently.
  return useMemo<ActiveChainInfo>(() => ({}), []);
}

export function getCosmosChains(
  multiProvider: MinimalProviderRegistry,
): ChainMetadata[] {
  const chains = [
    ...getChainsForProtocol(multiProvider, ProtocolType.Cosmos),
    ...getChainsForProtocol(multiProvider, ProtocolType.CosmosNative),
  ];
  if (!chains.some((chain) => chain.name === cosmoshub.name)) {
    chains.push(cosmoshub);
  }
  return chains;
}

export function getCosmosChainNames(
  multiProvider: MinimalProviderRegistry,
): ChainName[] {
  return getCosmosChains(multiProvider).map((c) => c.name);
}
