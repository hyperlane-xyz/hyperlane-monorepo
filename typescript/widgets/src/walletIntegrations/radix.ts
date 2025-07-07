import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import type {
  DeliverTxResponse,
  ExecuteResult,
  IndexedTx,
} from '@cosmjs/cosmwasm-stargate';
import { GasPrice } from '@cosmjs/stargate';
import { useChains } from '@cosmos-kit/react';
import {
  AuthLoginWithoutChallengeRequestItem,
  Logger,
  RadixDappToolkit,
  RadixNetwork,
} from '@radixdlt/radix-dapp-toolkit';
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

import { useRdt } from './radix/hooks/useRdt.js';
import {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  ChainTransactionFns,
  WalletDetails,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/radix',
});

export function useRadixAccount(
  multiProvider: MultiProtocolProvider,
): AccountInfo {
  console.log('useRadixAccount');
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
      protocol: ProtocolType.Radix,
      addresses,
      publicKey,
      isReady,
    };
  }, [chainToContext]);
}

export function useRadixWalletDetails() {
  console.log('useRadixWalletDetails');
  const name = 'Radix Wallet';
  const logoUrl =
    'https://raw.githubusercontent.com/radixdlt/radix-dapp-toolkit/refs/heads/main/docs/radix-logo.png';

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useRadixConnectFn(): () => void {
  console.log('useRadixConnectFn');
  const test = useRdt();
  console.log('useRdt', test);
  const rdt = RadixDappToolkit({
    networkId: RadixNetwork.Mainnet,
    applicationVersion: '1.0.0',
    applicationName: 'Radix Web3 dApp',
    applicationDappDefinitionAddress:
      'account_rdx12y7md4spfq5qy7e3mfjpa52937uvkxf0nmydsu5wydkkxw3qx6nghn',
    logger: Logger(1),
  });

  rdt.walletApi.setRequestData(AuthLoginWithoutChallengeRequestItem);
  return rdt.walletApi.sendRequest;
}

export function useRadixDisconnectFn(): () => Promise<void> {
  console.log('useRadixDisconnectFn');
  const rdt = RadixDappToolkit({
    networkId: RadixNetwork.Mainnet,
    applicationVersion: '1.0.0',
    applicationName: 'Radix Web3 dApp',
    applicationDappDefinitionAddress:
      'account_rdx12y7md4spfq5qy7e3mfjpa52937uvkxf0nmydsu5wydkkxw3qx6nghn',
    logger: Logger(1),
  });

  const safeDisconnect = async () => {
    if (rdt) rdt.disconnect();
  };
  return safeDisconnect;
}

export function useRadixActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  console.log('useRadixActiveChain');
  // Radix doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useRadixTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  console.log('useRadixTransactionFns');
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

  const onMultiSendTx = useCallback(
    async ({
      txs: _,
      chainName: __,
      activeChainName: ___,
    }: {
      txs: WarpTypedTransaction[];
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      throw new Error('Multi Transactions not supported on Cosmos');
    },
    [onSwitchNetwork, multiProvider],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork: onSwitchNetwork,
  };
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
