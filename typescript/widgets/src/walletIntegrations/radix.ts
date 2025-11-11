import {
  DataRequestBuilder,
  generateRolaChallenge,
} from '@radixdlt/radix-dapp-toolkit';
import { useCallback, useMemo } from 'react';

import { RadixSDKTransaction } from '@hyperlane-xyz/radix-sdk';
import {
  ChainName,
  IToken,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, retryAsync } from '@hyperlane-xyz/utils';

import { useAccount } from './radix/AccountContext.js';
import { usePopup } from './radix/RadixProviders.js';
import { useGatewayApi } from './radix/hooks/useGatewayApi.js';
import { useRdt } from './radix/hooks/useRdt.js';
import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

export function useRadixAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { accounts } = useAccount();

  return {
    protocol: ProtocolType.Radix,
    addresses: accounts.map((account) => ({
      address: account.address,
    })),
    publicKey: undefined, // we don't need the public key for radix
    isReady: !!accounts.length,
  };
}

export function useRadixWalletDetails() {
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
  const rdt = useRdt();
  assert(rdt, `radix dapp toolkit not defined`);

  const popUp = usePopup();
  assert(popUp, `radix wallet popup not defined`);

  const { setAccounts } = useAccount();

  rdt.walletApi.provideChallengeGenerator(async () => {
    return generateRolaChallenge();
  });

  const connect = async () => {
    popUp.setShowPopUp(true);

    rdt.walletApi.setRequestData(
      DataRequestBuilder.accounts().exactly(1).reset(),
    );
    const result = await rdt.walletApi.sendRequest();
    if (result.isOk()) {
      setAccounts(
        result.value.accounts.map((p) => ({
          address: p.address,
        })),
      );
    }
    popUp.setShowPopUp(false);
  };

  return connect;
}

export function useRadixDisconnectFn(): () => Promise<void> {
  const rdt = useRdt();
  assert(rdt, `radix dapp toolkit not defined`);

  const { setAccounts } = useAccount();

  const safeDisconnect = async () => {
    rdt.disconnect();
    setAccounts([]);
  };

  return safeDisconnect;
}

export function useRadixActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Radix doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useRadixSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      // Radix does not have switch capability
      throw new Error(
        `Radix wallet must be connected to origin chain ${displayName}`,
      );
    },
    [multiProvider],
  );

  return { switchNetwork: onSwitchNetwork };
}

export function useRadixWatchAsset(
  _multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const onAddAsset = useCallback(
    async (_token: IToken, _activeChainName: ChainName) => {
      throw new Error('Watch asset not available for Radix');
    },
    [],
  );

  return { addAsset: onAddAsset };
}

export function useRadixTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const rdt = useRdt();
  const gatewayApi = useGatewayApi();
  const { switchNetwork } = useRadixSwitchNetwork(multiProvider);

  const onSendTx = useCallback(
    async ({
      tx,
      chainName: _,
      activeChainName: __,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      assert(rdt, `radix dapp toolkit is not defined`);
      assert(gatewayApi, `gateway api is not defined`);

      const transaction = tx.transaction as RadixSDKTransaction;
      assert(
        typeof transaction.manifest === 'string',
        `transaction manifests needs to be a string`,
      );

      const transactionResult = await rdt.walletApi.sendTransaction({
        transactionManifest: transaction.manifest,
        version: 1,
      });

      if (transactionResult.isErr()) {
        throw transactionResult.error;
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(
          transactionResult.isOk(),
          `Radix tx failed: ${transactionResult}`,
        );

        const receipt = await retryAsync(
          () =>
            gatewayApi.transaction.getCommittedDetails(
              transactionResult.value.transactionIntentHash,
            ),
          5,
          5000,
        );

        return {
          type: tx.type as ProviderType.Radix,
          receipt: {
            ...receipt,
            transactionHash: transactionResult.value.transactionIntentHash,
          },
        };
      };
      return { hash: transactionResult.value.transactionIntentHash, confirm };
    },
    [switchNetwork],
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
      throw new Error('Multi Transactions not supported on Radix');
    },
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
  };
}
