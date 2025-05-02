import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import type {
  DeliverTxResponse,
  ExecuteResult,
  IndexedTx,
} from '@cosmjs/cosmwasm-stargate';
import { GasPrice } from '@cosmjs/stargate';
import { useChain, useChains } from '@cosmos-kit/react';
import { useCallback, useMemo } from 'react';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
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

export function useCosmosAccount(
  multiProvider: MultiProtocolProvider,
): AccountInfo {
  const cosmosChains = getCosmosChainNames(multiProvider);
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
      protocol: ProtocolType.Cosmos,
      addresses,
      publicKey,
      isReady,
    };
  }, [chainToContext]);
}

export function useCosmosWalletDetails() {
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

export function useCosmosConnectFn(): () => void {
  const { openView } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  return openView;
}

export function useCosmosDisconnectFn(): () => Promise<void> {
  const { disconnect, address } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const safeDisconnect = async () => {
    if (address) await disconnect();
  };
  return safeDisconnect;
}

export function useCosmosActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Cosmoskit doesn't have the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useCosmosTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const cosmosChains = getCosmosChainNames(multiProvider);
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
      const {
        getSigningCosmWasmClient,
        getSigningStargateClient,
        getOfflineSigner,
        chain,
      } = chainContext;
      let result: ExecuteResult | DeliverTxResponse;
      let txDetails: IndexedTx | null;
      if (tx.type === ProviderType.CosmJsWasm) {
        const client = await getSigningCosmWasmClient();
        result = await client.executeMultiple(
          chainContext.address,
          [tx.transaction],
          'auto',
        );
        txDetails = await client.getTx(result.transactionHash);
      } else if (tx.type === ProviderType.CosmJs) {
        const client = await getSigningStargateClient();
        // The fee param of 'auto' here stopped working for Neutron-based IBC transfers
        // It seems the signAndBroadcast method uses a default fee multiplier of 1.4
        // https://github.com/cosmos/cosmjs/blob/e819a1fc0e99a3e5320d8d6667a08d3b92e5e836/packages/stargate/src/signingstargateclient.ts#L115
        // A multiplier of 1.6 was insufficient for Celestia -> Neutron|Cosmos -> XXX transfers, but 2 worked.
        result = await client.signAndBroadcast(
          chainContext.address,
          [tx.transaction],
          2,
        );
        txDetails = await client.getTx(result.transactionHash);
      } else if (tx.type === ProviderType.CosmJsNative) {
        const signer = getOfflineSigner();
        const client = await SigningHyperlaneModuleClient.connectWithSigner(
          chain.apis!.rpc![0].address,
          signer,
          {
            // set zero gas price here so it does not error. actual gas price
            // will be injected from the wallet registry like Keplr or Leap
            gasPrice: GasPrice.fromString('0token'),
          },
        );

        result = await client.signAndBroadcast(
          chainContext.address,
          [tx.transaction],
          2,
        );
        txDetails = await client.getTx(result.transactionHash);
      } else {
        throw new Error(`Invalid cosmos provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(txDetails, `Cosmos tx failed: ${JSON.stringify(result)}`);
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

function getCosmosChains(
  multiProvider: MultiProtocolProvider,
): ChainMetadata[] {
  return [
    ...getChainsForProtocol(multiProvider, ProtocolType.Cosmos),
    ...getChainsForProtocol(multiProvider, ProtocolType.CosmosNative),
    cosmoshub,
  ];
}

function getCosmosChainNames(
  multiProvider: MultiProtocolProvider,
): ChainName[] {
  return getCosmosChains(multiProvider).map((c) => c.name);
}

// Metadata formatted for use in Wagmi config
export function getCosmosKitChainConfigs(
  multiProvider: MultiProtocolProvider,
): {
  chains: CosmosChain[];
  assets: AssetList[];
} {
  const chains = getCosmosChains(multiProvider);
  const configList = chains.map(chainMetadataToCosmosChain);
  return {
    chains: configList.map((c) => c.chain),
    assets: configList.map((c) => c.assets),
  };
}
