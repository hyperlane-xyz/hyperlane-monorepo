import { Chain } from '@starknet-react/chains';
import {
  useAccount,
  useSendTransaction,
  useSwitchChain,
} from '@starknet-react/core';
import { useCallback } from 'react';
import { Call } from 'starknet';

import { chainMetadataToStarknetChain } from '@hyperlane-xyz/sdk/metadata/chainMetadataConversion';
import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';
import { ProtocolType, assert, sleep } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';
import { getChainsForProtocol } from './utils.js';

const logger = widgetLogger.child({
  module: 'widgets/walletIntegrations/starknet',
});
export {
  useStarknetAccount,
  useStarknetActiveChain,
  useStarknetConnectFn,
  useStarknetDisconnectFn,
  useStarknetWalletDetails,
} from './starknetBase.js';

export function useStarknetSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const { switchChainAsync } = useSwitchChain({});

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const chainId = multiProvider.getChainMetadata(chainName).chainId;
      try {
        await switchChainAsync({
          chainId: chainId.toString(),
        });
        // Some wallets seem to require a brief pause after switch
        await sleep(4000);
      } catch {
        // some wallets like braavos do not support chain switching
        logger.warn('Failed to switch chain.');
      }
    },
    [multiProvider, switchChainAsync],
  );

  return { switchNetwork: onSwitchNetwork };
}

export function useStarknetWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for starknet');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useStarknetTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { account } = useAccount();

  const { sendAsync } = useSendTransaction({});
  const { switchNetwork } = useStarknetSwitchNetwork(multiProvider);

  const onMultiSendTx = useCallback(
    async ({
      txs,
      chainName,
      activeChainName,
    }: {
      txs: WarpTypedTransaction[];
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (txs.some((tx) => tx.type !== ProviderType.Starknet)) {
        throw new Error(
          `Invalid transaction type for Starknet: ${txs.map((tx) => tx.type).join(',')}`,
        );
      }

      if (activeChainName && activeChainName !== chainName) {
        await switchNetwork(chainName);
      }

      if (!account) {
        throw new Error('No StarkNet account connected');
      }

      const chainId = multiProvider.getChainMetadata(chainName).chainId;
      const chainIdFromWallet = await account.getChainId();

      try {
        assert(
          chainIdFromWallet === chainId,
          `Wallet not on chain ${chainName} (ChainMismatchError)`,
        );

        const result = await sendAsync(txs.map((tx) => tx.transaction as Call));
        const hash = result.transaction_hash;
        const confirm = async (): Promise<TypedTransactionReceipt> => {
          const receipt = await account.waitForTransaction(hash);
          return {
            type: ProviderType.Starknet,
            receipt,
          };
        };

        return { hash, confirm };
      } catch (error) {
        logger.error('Failed to send StarkNet transactions:', error);
        throw error;
      }
    },
    [account, multiProvider, switchNetwork, sendAsync],
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
      return onMultiSendTx({
        txs: [tx],
        chainName,
        activeChainName,
      });
    },
    [onMultiSendTx],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}

export function getStarknetChains(
  multiProvider: MultiProtocolProvider,
): Chain[] {
  return getChainsForProtocol(multiProvider, ProtocolType.Starknet).map(
    chainMetadataToStarknetChain,
  );
}
