import { useWallet } from '@solana/wallet-adapter-react';
import { Connection } from '@solana/web3.js';
import { useCallback } from 'react';

import {
  ProviderType,
  type TypedTransactionReceipt,
} from '@hyperlane-xyz/sdk/providers/ProviderType';
import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '@hyperlane-xyz/sdk/providers/ConfiguredMultiProtocolProvider';
import type { ITokenMetadata } from '@hyperlane-xyz/sdk/token/ITokenMetadata';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import type { WarpTypedTransaction } from '@hyperlane-xyz/sdk/warp/types';

import { widgetLogger } from '../logger.js';

import {
  ChainTransactionFns,
  SwitchNetworkFns,
  WatchAssetFns,
} from './types.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/solana' });
export {
  useSolanaAccount,
  useSolanaActiveChain,
  useSolanaConnectFn,
  useSolanaDisconnectFn,
  useSolanaWalletDetails,
} from './solanaBase.js';

export function useSolanaSwitchNetwork(): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    logger.warn(`Solana wallet must be connected to origin chain ${chainName}`);
  }, []);

  return { switchNetwork: onSwitchNetwork };
}

export function useSolanaWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: ITokenMetadata, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for solana');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useSolanaTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { sendTransaction: sendSolTransaction } = useWallet();
  const { switchNetwork } = useSolanaSwitchNetwork();

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
      if (tx.type !== ProviderType.SolanaWeb3)
        throw new Error(`Unsupported tx type: ${tx.type}`);
      if (activeChainName && activeChainName !== chainName)
        await switchNetwork(chainName);
      const rpcUrl = multiProvider.getRpcUrl(chainName);
      const connection = new Connection(rpcUrl, 'confirmed');
      const {
        context: { slot: minContextSlot },
        value: { blockhash, lastValidBlockHeight },
      } = await connection.getLatestBlockhashAndContext();

      logger.debug(`Sending tx on chain ${chainName}`);
      const signature = await sendSolTransaction(tx.transaction, connection, {
        minContextSlot,
      });

      const confirm = (): Promise<TypedTransactionReceipt> =>
        connection
          .confirmTransaction({ blockhash, lastValidBlockHeight, signature })
          .then(() => connection.getTransaction(signature))
          .then((r) => ({
            type: ProviderType.SolanaWeb3,
            receipt: r!,
          }));

      return { hash: signature, confirm };
    },
    [switchNetwork, sendSolTransaction, multiProvider],
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
      throw new Error('Multi Transactions not supported on Solana');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
