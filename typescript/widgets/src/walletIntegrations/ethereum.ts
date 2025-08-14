import { useConnectModal } from '@rainbow-me/rainbowkit';
import {
  getAccount,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
  watchAsset,
} from '@wagmi/core';
import { useCallback, useMemo } from 'react';
import { Chain as ViemChain } from 'viem';
import { useAccount, useConfig, useDisconnect } from 'wagmi';

import {
  ChainName,
  EvmHypXERC20LockboxAdapter,
  IToken,
  LOCKBOX_STANDARDS,
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
  SwitchNetworkFns,
  WalletDetails,
  WatchAssetFns,
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

export function useEthereumSwitchNetwork(
  multiProvider: MultiProtocolProvider,
): SwitchNetworkFns {
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

  return { switchNetwork: onSwitchNetwork };
}

export function useEthereumWatchAsset(
  multiProvider: MultiProtocolProvider,
): WatchAssetFns {
  const { switchNetwork } = useEthereumSwitchNetwork(multiProvider);
  const config = useConfig();

  const onAddAsset = useCallback(
    async (token: IToken, activeChainName: ChainName) => {
      const chainName = token.chainName;
      // If the active chain is different from tx origin chain, try to switch network first
      if (activeChainName && activeChainName !== chainName)
        await switchNetwork(chainName);

      let tokenAddress = '';
      if (LOCKBOX_STANDARDS.includes(token.standard)) {
        const adapter = token.getAdapter(
          multiProvider,
        ) as EvmHypXERC20LockboxAdapter;
        tokenAddress = await adapter.getWrappedTokenAddress();
      } else {
        tokenAddress = token.collateralAddressOrDenom || token.addressOrDenom;
      }

      return watchAsset(config, {
        type: 'ERC20',
        options: {
          address: tokenAddress,
          decimals: token.decimals,
          symbol: token.symbol,
        },
      });
    },
    [config, switchNetwork, multiProvider],
  );

  return { addAsset: onAddAsset };
}

export function useEthereumTransactionFns(
  multiProvider: MultiProtocolProvider,
): ChainTransactionFns {
  const config = useConfig();
  const { switchNetwork } = useEthereumSwitchNetwork(multiProvider);

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
        await switchNetwork(chainName);

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
    [config, switchNetwork, multiProvider],
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
    [],
  );

  return {
    sendTransaction: onSendTx,
    sendMultiTransaction: onMultiSendTx,
    switchNetwork,
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
