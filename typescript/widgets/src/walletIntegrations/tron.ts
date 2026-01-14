import { useWallet } from '@tronweb3/tronwallet-adapter-react-hooks';
import { useCallback, useMemo } from 'react';

import {
  ChainName,
  IToken,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  ChainTransactionFns,
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

export function useTronAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { address, connected } = useWallet();

  return useMemo<AccountInfo>(() => {
    const addresses: Array<ChainAddress> = [];
    if (address) {
      addresses.push({ address });
    }

    return {
      protocol: ProtocolType.Tron,
      addresses,
      publicKey: undefined,
      isReady: connected && !!address,
    };
  }, [address, connected]);
}

export function useTronWalletDetails() {
  const { wallet } = useWallet();
  const { icon, name } = wallet?.adapter || {};

  return useMemo<WalletDetails>(
    () => ({
      name: name,
      logoUrl: icon,
    }),
    [name, icon],
  );
}

export function useTronConnectFn(): () => void {
  const { connect } = useWallet();
  return connect;
}

export function useTronDisconnectFn(): () => Promise<void> {
  const { disconnect } = useWallet();
  return disconnect;
}

export function useTronActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Tron doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useTronSwitchNetwork(
  _multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(async (chainName: ChainName) => {
    // Most Tron wallets (like TronLink) don't support programmatic
    // network switching via a DApp standard like EIP-3326.
    throw new Error(
      `Please manually switch your Tron wallet to ${chainName} (Mainnet/Nile/Shasta)`,
    );
  }, []);

  return { switchNetwork: onSwitchNetwork };
}

export function useTronWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: IToken, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Tron');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

/**
 * Core Transaction Functionality for Tron.
 */
export function useTronTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const { address, signTransaction, connected } = useWallet();
  const { switchNetwork } = useTronSwitchNetwork(multiProvider);

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName: _,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      if (!connected || !address) throw new Error(`Tron wallet not connected`);

      const provider = multiProvider.getProvider(chainName);

      let txID: string;

      if (
        tx.type === ProviderType.Tron &&
        provider.type === ProviderType.Tron
      ) {
        const signedTransaction = await signTransaction(tx.transaction);

        const result =
          await provider.provider['tronweb'].trx.sendRawTransaction(
            signedTransaction,
          );

        if (!result.result) {
          throw new Error(`Tron broadcast failed: ${JSON.stringify(result)}`);
        }
        txID = result.txid;
      } else {
        throw new Error(`Invalid Tron provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        let receipt: any = null;
        while (!receipt) {
          receipt =
            await provider.provider['tronweb'].trx.getConfirmedTransaction(
              txID,
            );
          if (!receipt) await new Promise((r) => setTimeout(r, 2000));
        }

        return {
          type: tx.type,
          receipt,
        };
      };

      return { hash: txID, confirm };
    },
    [address, connected, signTransaction, multiProvider],
  );

  const onMultiSendTx = useCallback(async () => {
    throw new Error('Multi Transactions not supported on Tron');
  }, []);

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
