import { useConnectModal } from '@rainbow-me/rainbowkit';
import {
  getAccount,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
} from '@wagmi/core';
import { useCallback, useMemo } from 'react';
import { Chain as ViemChain } from 'viem';
import { useAccount, useConfig, useDisconnect } from 'wagmi';

import {
  ChainName,
  MultiProtocolProvider,
  ProviderType,
  TypedTransactionReceipt,
  WarpTypedTransaction,
  chainMetadataToViemChain,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, sleep } from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
} from './types.js';
import { ethers5TxToWagmiTx, getChainsForProtocol } from './utils.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/ethereum' });

export function useEthereumAccount(
  _multiProvider: MultiProtocolProvider,
): AccountInfo {
  const { address, isConnected, connector } = useAccount();
  const isReady = !!(address && isConnected && connector);

  return useMemo<AccountInfo>(
    () => ({
      protocol: ProtocolType.Ethereum,
      addresses: address ? [{ address: `${address}` }] : [],
      isReady: isReady,
    }),
    [address, isReady],
  );
}

export function useEthereumWalletDetails() {
  const { connector } = useAccount();
  const name = connector?.name;
  const logoUrl = connector?.icon;

  return useMemo<WalletDetails>(
    () => ({
      name,
      logoUrl,
    }),
    [name, logoUrl],
  );
}

export function useEthereumConnectFn(): () => void {
  const { openConnectModal } = useConnectModal();
  return useCallback(() => openConnectModal?.(), [openConnectModal]);
}

export function useEthereumDisconnectFn(): () => Promise<void> {
  const { disconnectAsync } = useDisconnect();
  return disconnectAsync;
}

export function useEthereumActiveChain(
  multiProvider: MultiProtocolProvider,
): ActiveChainInfo {
  const { chain } = useAccount();
  return useMemo<ActiveChainInfo>(
    () => ({
      chainDisplayName: chain?.name,
      chainName: chain
        ? multiProvider.tryGetChainMetadata(chain.id)?.name
        : undefined,
    }),
    [chain, multiProvider],
  );
}

export function useEthereumTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const config = useConfig();

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const chainId = multiProvider.getChainMetadata(chainName)
        .chainId as number;
      await switchChain(config, { chainId });
      // Some wallets seem to require a brief pause after switch
      await sleep(2000);
    },
    [config, multiProvider],
  );
  // Note, this doesn't use wagmi's prepare + send pattern because we're potentially sending two transactions
  // The prepare hooks are recommended to use pre-click downtime to run async calls, but since the flow
  // may require two serial txs, the prepare hooks aren't useful and complicate hook architecture considerably.
  // See https://github.com/hyperlane-xyz/hyperlane-warp-ui-template/issues/19
  // See https://github.com/wagmi-dev/wagmi/discussions/1564
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
      if (tx.type !== ProviderType.EthersV5)
        throw new Error(`Unsupported tx type: ${tx.type}`);

      // If the active chain is different from tx origin chain, try to switch network first
      if (activeChainName && activeChainName !== chainName)
        await onSwitchNetwork(chainName);

      // Since the network switching is not foolproof, we also force a network check here
      const chainId = multiProvider.getChainMetadata(chainName)
        .chainId as number;
      logger.debug('Checking wallet current chain');
      const latestNetwork = await getAccount(config);
      assert(
        latestNetwork?.chain?.id === chainId,
        `Wallet not on chain ${chainName} (ChainMismatchError)`,
      );

      logger.debug(`Sending tx on chain ${chainName}`);
      const wagmiTx = ethers5TxToWagmiTx(tx.transaction);
      const hash = await sendTransaction(config, {
        chainId,
        ...wagmiTx,
      });
      const confirm = (): Promise<TypedTransactionReceipt> => {
        const foo = waitForTransactionReceipt(config, {
          chainId,
          hash,
          confirmations: 1,
        });
        return foo.then((r) => ({
          type: ProviderType.Viem,
          receipt: { ...r, contractAddress: r.contractAddress || null },
        }));
      };

      return { hash, confirm };
    },
    [config, onSwitchNetwork, multiProvider],
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
      throw new Error('Multi Transactions not supported on EVM');
    },
    [config, onSwitchNetwork, multiProvider],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork: onSwitchNetwork,
  };
}

// Metadata formatted for use in Wagmi config
export function getWagmiChainConfigs(
  multiProvider: MultiProtocolProvider,
): ViemChain[] {
  return getChainsForProtocol(multiProvider, ProtocolType.Ethereum).map(
    chainMetadataToViemChain,
  );
}
