import {
  DataRequestBuilder,
  generateRolaChallenge,
} from '@radixdlt/radix-dapp-toolkit';
import { RadixEngineToolkit } from '@radixdlt/radix-engine-toolkit';
import { useCallback, useMemo } from 'react';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { RTransaction } from '../../../sdk/dist/providers/ProviderType.js';

import { useAccount } from './radix/AccountContext.js';
import { usePopup } from './radix/WalletPopupProvider.js';
import { useGatewayApi } from './radix/hooks/useGatewayApi.js';
import { useRdt } from './radix/hooks/useRdt.js';
import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
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
    publicKey: new Promise((resolve) => resolve(accounts[0]?.publicKey ?? '')),
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
      DataRequestBuilder.accounts().exactly(1).withProof().reset(),
    );
    const result = await rdt.walletApi.sendRequest();
    if (result.isOk()) {
      setAccounts(
        result.value.proofs.map((p) => ({
          address: p.address,
          publicKey: p.proof.publicKey,
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

  const safeDisconnect = async () => {
    rdt.disconnect();
  };

  return safeDisconnect;
}

export function useRadixActiveChain(
  _multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  // Radix doesn't has the concept of an active chain
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useRadixTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const rdt = useRdt();
  const gatewayApi = useGatewayApi();

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName =
        multiProvider.getChainMetadata(chainName).displayName || chainName;
      throw new Error(
        `Radix wallet must be connected to origin chain ${displayName}}`,
      );
    },
    [multiProvider],
  );

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

      const transaction = tx.transaction as never as RTransaction;

      const transactionManifest = (
        await RadixEngineToolkit.Instructions.convert(
          transaction.manifest.instructions,
          transaction.networkId,
          'String',
        )
      ).value as string;

      const transactionResult = await rdt.walletApi.sendTransaction({
        transactionManifest,
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

        const receipt = await gatewayApi.transaction.getCommittedDetails(
          transactionResult.value.transactionIntentHash,
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
    [onSwitchNetwork],
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
    [onSwitchNetwork, multiProvider],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork: onSwitchNetwork,
  };
}
