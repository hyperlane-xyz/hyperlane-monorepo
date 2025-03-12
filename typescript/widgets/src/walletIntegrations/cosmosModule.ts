import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import type { DeliverTxResponse, IndexedTx } from '@cosmjs/cosmwasm-stargate';
import { useChain, useChains } from '@cosmos-kit/react';
import { useCallback, useMemo } from 'react';

import { cosmoshub } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
  chainMetadataToCosmosChain,
} from '@hyperlane-xyz/sdk';
import { HexString, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  ChainTransactionFns,
  WalletDetails,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

// Used because the CosmosKit hooks always require a chain name
const PLACEHOLDER_COSMOS_CHAIN = cosmoshub.name;

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/cosmos',
});

export function useCosmosModuleAccount(
  multiProvider: MultiProtocolProvider,
): AccountInfo {
  const cosmosChains = getCosmosModuleChainNames(multiProvider);
  const chainToContext = useChains(cosmosChains);
  return useMemo<AccountInfo>(() => {
    const addresses: Array<ChainAddress> = [];
    let publicKey: Promise<HexString> | undefined = undefined;
    let connectorName: string | undefined = undefined;
    let isReady = false;
    for (const [chainName, context] of Object.entries(chainToContext)) {
      if (!context.address) continue;
      addresses.push({ address: context.address, chainName });
      publicKey = context
        .getAccount()
        .then((acc) => Buffer.from(acc.pubkey).toString('hex'));
      isReady = true;
      connectorName ||= context.wallet?.prettyName;
    }
    return {
      protocol: ProtocolType.CosmosModule,
      addresses,
      publicKey,
      isReady,
    };
  }, [chainToContext]);
}

export function useCosmosModuleWalletDetails() {
  const { wallet } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const { logo, prettyName } = wallet || {};

  return useMemo<WalletDetails>(
    () => ({
      name: prettyName,
      logoUrl: typeof logo === 'string' ? logo : undefined,
    }),
    [prettyName, logo],
  );
}

export function useCosmosModuleConnectFn(): () => void {
  const { openView } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  return openView;
}

export function useCosmosModuleDisconnectFn(): () => Promise<void> {
  const { disconnect, address } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const safeDisconnect = async () => {
    if (address) await disconnect();
  };
  return safeDisconnect;
}

export function useCosmosModuleActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Cosmoskit doesn't have the concept of an active chain
  return useMemo(() => ({} as ActiveChainInfo), []);
}

export function useCosmosModuleTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const cosmosChains = getCosmosModuleChainNames(multiProvider);
  const chainToContext = useChains(cosmosChains);

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      // CosmosKit does not have switch capability
      throw new Error(
        `Cosmos wallet must be connected to origin chain ${displayName}}`,
      );
    },
    [multiProvider],
  );

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      const chainContext = chainToContext[chainName];
      if (!chainContext?.address)
        throw new Error(`Cosmos wallet not connected for ${chainName}`);

      if (activeChainName && activeChainName !== chainName)
        await onSwitchNetwork(chainName);

      logger.debug(`Sending tx on chain ${chainName}`);
      const { getSigningStargateClient } = chainContext;
      let result: DeliverTxResponse;
      let txDetails: IndexedTx | null;

      if (tx.type === ProviderType.CosmosModule) {
        const client = await getSigningStargateClient();
        result = await client.signAndBroadcast(
          chainContext.address,
          [tx.transaction],
          2,
        );
        txDetails = await client.getTx(result.transactionHash);
      } else {
        throw new Error(`Invalid cosmos module provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(txDetails, `Cosmos module tx failed: ${JSON.stringify(result)}`);
        return {
          type: tx.type,
          receipt: { ...txDetails, transactionHash: result.transactionHash },
        };
      };
      return { hash: result.transactionHash, confirm };
    },
    [onSwitchNetwork, chainToContext],
  );

  return { sendTransaction: onSendTx, switchNetwork: onSwitchNetwork };
}

function getCosmosModuleChains(
  multiProvider: MultiProtocolProvider,
): ChainMetadata[] {
  return [
    ...getChainsForProtocol(multiProvider, ProtocolType.CosmosModule),
    cosmoshub,
  ];
}

function getCosmosModuleChainNames(
  multiProvider: MultiProtocolProvider,
): ChainName[] {
  return getCosmosModuleChains(multiProvider).map((c) => c.name);
}

// Metadata formatted for use in Wagmi config
export function getCosmosModuleKitChainConfigs(
  multiProvider: MultiProtocolProvider,
): {
  chains: CosmosChain[];
  assets: AssetList[];
} {
  const chains = getCosmosModuleChains(multiProvider);
  const configList = chains.map(chainMetadataToCosmosChain);
  return {
    chains: configList.map((c) => c.chain),
    assets: configList.map((c) => c.assets),
  };
}
