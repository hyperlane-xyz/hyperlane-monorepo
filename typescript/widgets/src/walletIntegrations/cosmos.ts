import type { AssetList, Chain as CosmosChain } from '@chain-registry/types';
import type { DeliverTxResponse } from '@cosmjs/cosmwasm-stargate';
import { useChains } from '@cosmos-kit/react';
import { useCallback } from 'react';

import { CosmosNativeSigner } from '@hyperlane-xyz/cosmos-sdk/runtime';
import { chainMetadataToCosmosChain } from '@hyperlane-xyz/sdk/metadata/chainMetadataConversion';
import {
  type TypedTransactionReceipt,
  ProviderType,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';
import { assert } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';
import { getCosmosChainNames, getCosmosChains } from './cosmosWallet.js';

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/cosmos',
});
export {
  useCosmosAccount,
  useCosmosActiveChain,
  useCosmosConnectFn,
  useCosmosDisconnectFn,
  useCosmosWalletDetails,
} from './cosmosWallet.js';

export function useCosmosSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
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

  return { switchNetwork: onSwitchNetwork };
}

export function useCosmosWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for cosmos');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useCosmosTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const cosmosChains = getCosmosChainNames(multiProvider);
  const chainToContext = useChains(cosmosChains);
  const { switchNetwork } = useCosmosSwitchNetwork(multiProvider);

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
        await switchNetwork(chainName);

      logger.debug(`Sending tx on chain ${chainName}`);
      const {
        getSigningCosmWasmClient,
        getSigningStargateClient,
        getOfflineSigner,
        chain,
      } = chainContext;
      let receipt: DeliverTxResponse;

      if (tx.type === ProviderType.CosmJsWasm) {
        const client = await getSigningCosmWasmClient();
        const executionResult = await client.executeMultiple(
          chainContext.address,
          [tx.transaction],
          'auto',
        );
        const txDetails = await client.getTx(executionResult.transactionHash);
        assert(txDetails, `Cosmos tx failed: ${JSON.stringify(txDetails)}`);
        receipt = {
          ...txDetails,
          transactionHash: executionResult.transactionHash,
        };
      } else if (tx.type === ProviderType.CosmJs) {
        const client = await getSigningStargateClient();
        // The fee param of 'auto' here stopped working for Neutron-based IBC transfers
        // It seems the signAndBroadcast method uses a default fee multiplier of 1.4
        // https://github.com/cosmos/cosmjs/blob/e819a1fc0e99a3e5320d8d6667a08d3b92e5e836/packages/stargate/src/signingstargateclient.ts#L115
        // A multiplier of 1.6 was insufficient for Celestia -> Neutron|Cosmos -> XXX transfers, but 2 worked.
        receipt = await client.signAndBroadcast(
          chainContext.address,
          [tx.transaction],
          2,
        );
      } else if (tx.type === ProviderType.CosmJsNative) {
        const signer = getOfflineSigner();
        const client = await CosmosNativeSigner.connectWithSigner(
          chain.apis?.rpc?.map((rpc) => rpc.address) ?? [],
          signer,
          {
            // set zero gas price here so it does not error. actual gas price
            // will be injected from the wallet registry like Keplr or Leap
            metadata: {
              gasPrice: {
                amount: '0',
                denom: 'token',
              },
            },
          },
        );

        receipt = await client.sendAndConfirmTransaction(tx.transaction);
      } else {
        throw new Error(`Invalid cosmos provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          receipt && receipt.code === 0,
          `Cosmos tx failed: ${JSON.stringify(receipt)}`,
        );
        return {
          type: tx.type,
          receipt,
        };
      };
      return { hash: receipt.transactionHash, confirm };
    },
    [switchNetwork, chainToContext],
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
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
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
