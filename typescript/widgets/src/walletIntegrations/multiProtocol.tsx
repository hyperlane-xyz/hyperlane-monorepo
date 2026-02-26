import { useMemo } from 'react';

import { cosmoshub } from '@hyperlane-xyz/registry';
import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import {
  Address,
  HexString,
  KnownProtocolType,
  ProtocolType,
} from '@hyperlane-xyz/utils';

import { widgetLogger } from '../logger.js';

import {
  useAleoAccount,
  useAleoActiveChain,
  useAleoConnectFn,
  useAleoDisconnectFn,
  useAleoTransactionFns,
  useAleoWalletDetails,
  useAleoWatchAsset,
} from './aleo.js';
import {
  useCosmosAccount,
  useCosmosActiveChain,
  useCosmosConnectFn,
  useCosmosDisconnectFn,
  useCosmosTransactionFns,
  useCosmosWalletDetails,
  useCosmosWatchAsset,
} from './cosmos.js';
import {
  useEthereumAccount,
  useEthereumActiveChain,
  useEthereumConnectFn,
  useEthereumDisconnectFn,
  useEthereumTransactionFns,
  useEthereumWalletDetails,
  useEthereumWatchAsset,
} from './ethereum.js';
import {
  useRadixAccount,
  useRadixActiveChain,
  useRadixConnectFn,
  useRadixDisconnectFn,
  useRadixTransactionFns,
  useRadixWalletDetails,
  useRadixWatchAsset,
} from './radix.js';
import {
  useSolanaAccount,
  useSolanaActiveChain,
  useSolanaConnectFn,
  useSolanaDisconnectFn,
  useSolanaTransactionFns,
  useSolanaWalletDetails,
  useSolanaWatchAsset,
} from './solana.js';
import {
  useStarknetAccount,
  useStarknetActiveChain,
  useStarknetConnectFn,
  useStarknetDisconnectFn,
  useStarknetTransactionFns,
  useStarknetWalletDetails,
  useStarknetWatchAsset,
} from './starknet.js';
import {
  AccountInfo,
  ActiveChainInfo,
  ChainTransactionFns,
  WalletDetails,
  WatchAssetFns,
} from './types.js';

const logger = widgetLogger.child({
  module: 'walletIntegrations/multiProtocol',
});

export function useAccounts(
  multiProvider: MultiProtocolProvider,
  blacklistedAddresses: Address[] = [],
): {
  accounts: Record<KnownProtocolType, AccountInfo>;
  readyAccounts: Array<AccountInfo>;
} {
  const evmAccountInfo = useEthereumAccount(multiProvider);
  const solAccountInfo = useSolanaAccount(multiProvider);
  const cosmAccountInfo = useCosmosAccount(multiProvider);
  const starknetAccountInfo = useStarknetAccount(multiProvider);
  const radixAccountInfo = useRadixAccount(multiProvider);
  const aleoAccountInfo = useAleoAccount(multiProvider);

  // Filtered ready accounts
  const readyAccounts = useMemo(
    () =>
      [
        evmAccountInfo,
        solAccountInfo,
        cosmAccountInfo,
        starknetAccountInfo,
        radixAccountInfo,
        aleoAccountInfo,
      ].filter((a) => a.isReady),
    [
      evmAccountInfo,
      solAccountInfo,
      cosmAccountInfo,
      starknetAccountInfo,
      radixAccountInfo,
      aleoAccountInfo,
    ],
  );

  // Check if any of the ready accounts are blacklisted
  const readyAddresses = readyAccounts
    .map((a) => a.addresses)
    .flat()
    .map((a) => a.address.toLowerCase());
  if (readyAddresses.some((a) => blacklistedAddresses.includes(a))) {
    throw new Error('Wallet address is blacklisted');
  }

  return useMemo(
    () => ({
      accounts: {
        [ProtocolType.Ethereum]: evmAccountInfo,
        [ProtocolType.Sealevel]: solAccountInfo,
        [ProtocolType.Cosmos]: cosmAccountInfo,
        [ProtocolType.CosmosNative]: cosmAccountInfo,
        [ProtocolType.Starknet]: starknetAccountInfo,
        [ProtocolType.Radix]: radixAccountInfo,
        [ProtocolType.Aleo]: aleoAccountInfo,
      },
      readyAccounts,
    }),
    [
      evmAccountInfo,
      solAccountInfo,
      cosmAccountInfo,
      starknetAccountInfo,
      radixAccountInfo,
      aleoAccountInfo,
      readyAccounts,
    ],
  );
}

export function useAccountForChain(
  multiProvider: MultiProtocolProvider,
  chainName?: ChainName,
): AccountInfo | undefined {
  const { accounts } = useAccounts(multiProvider);
  const protocol = chainName ? multiProvider.getProtocol(chainName) : undefined;
  if (!chainName || !protocol) return undefined;
  return accounts?.[protocol];
}

export function useAccountAddressForChain(
  multiProvider: MultiProtocolProvider,
  chainName?: ChainName,
): Address | undefined {
  const { accounts } = useAccounts(multiProvider);
  return getAccountAddressForChain(multiProvider, chainName, accounts);
}

export function getAccountAddressForChain(
  multiProvider: MultiProtocolProvider,
  chainName?: ChainName,
  accounts?: Record<KnownProtocolType, AccountInfo>,
): Address | undefined {
  if (!chainName || !accounts) return undefined;
  const protocol = multiProvider.getProtocol(chainName);
  const account = accounts[protocol];
  if (
    protocol === ProtocolType.Cosmos ||
    protocol === ProtocolType.CosmosNative
  ) {
    return account?.addresses.find((a) => a.chainName === chainName)?.address;
  } else {
    // Use first because only cosmos has the notion of per-chain addresses
    return account?.addresses[0]?.address;
  }
}

export function getAddressFromAccountAndChain(
  account?: AccountInfo,
  chainName?: ChainName,
) {
  if (!account) {
    return 'Unknown';
  }

  // only in cosmos there are multiple addresses per account, in this
  // case we display the cosmos hub address by default. If the user
  // selects a cosmos based origin chain in the swap form that cosmos
  // address is displayed instead
  if (account.protocol === ProtocolType.Cosmos) {
    // chainName can be an EVM chain here, therefore if no
    // cosmos address was found we search for the cosmos hub
    // address below
    const cosmosAddress = account?.addresses?.find(
      (a) => a.chainName === chainName,
    )?.address;

    // if no cosmos address was found for the chain name we search
    // for the cosmos hub address as fallback
    return (
      cosmosAddress ??
      account?.addresses?.find((a) => a.chainName === cosmoshub.name)
        ?.address ??
      'Unknown'
    );
  }

  // by default display the first address of the account
  return account.addresses[0]?.address ?? 'Unknown';
}

export function getAccountAddressAndPubKey(
  multiProvider: MultiProtocolProvider,
  chainName?: ChainName,
  accounts?: Record<KnownProtocolType, AccountInfo>,
): { address?: Address; publicKey?: Promise<HexString> } {
  const address = getAccountAddressForChain(multiProvider, chainName, accounts);
  if (!accounts || !chainName || !address) return {};
  const protocol = multiProvider.getProtocol(chainName);
  const publicKey = accounts[protocol]?.publicKey;
  return { address, publicKey };
}

export function useWalletDetails(): Record<KnownProtocolType, WalletDetails> {
  const evmWallet = useEthereumWalletDetails();
  const solWallet = useSolanaWalletDetails();
  const cosmosWallet = useCosmosWalletDetails();
  const starknetWallet = useStarknetWalletDetails();
  const radixWallet = useRadixWalletDetails();
  const aleoWallet = useAleoWalletDetails();

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: evmWallet,
      [ProtocolType.Sealevel]: solWallet,
      [ProtocolType.Cosmos]: cosmosWallet,
      [ProtocolType.CosmosNative]: cosmosWallet,
      [ProtocolType.Starknet]: starknetWallet,
      [ProtocolType.Radix]: radixWallet,
      [ProtocolType.Aleo]: aleoWallet,
    }),
    [
      evmWallet,
      solWallet,
      cosmosWallet,
      starknetWallet,
      radixWallet,
      aleoWallet,
    ],
  );
}

export function useConnectFns(): Record<KnownProtocolType, () => void> {
  const onConnectEthereum = useEthereumConnectFn();
  const onConnectSolana = useSolanaConnectFn();
  const onConnectCosmos = useCosmosConnectFn();
  const onConnectStarknet = useStarknetConnectFn();
  const onConnectRadix = useRadixConnectFn();
  const onConnectAleo = useAleoConnectFn();

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: onConnectEthereum,
      [ProtocolType.Sealevel]: onConnectSolana,
      [ProtocolType.Cosmos]: onConnectCosmos,
      [ProtocolType.CosmosNative]: onConnectCosmos,
      [ProtocolType.Starknet]: onConnectStarknet,
      [ProtocolType.Radix]: onConnectRadix,
      [ProtocolType.Aleo]: onConnectAleo,
    }),
    [
      onConnectEthereum,
      onConnectSolana,
      onConnectCosmos,
      onConnectStarknet,
      onConnectRadix,
      onConnectAleo,
    ],
  );
}

export function useDisconnectFns(): Record<
  KnownProtocolType,
  () => Promise<void>
> {
  const disconnectEvm = useEthereumDisconnectFn();
  const disconnectSol = useSolanaDisconnectFn();
  const disconnectCosmos = useCosmosDisconnectFn();
  const disconnectStarknet = useStarknetDisconnectFn();
  const disconnectRadix = useRadixDisconnectFn();
  const disconnectAleo = useAleoDisconnectFn();

  const onClickDisconnect =
    (env: ProtocolType, disconnectFn?: () => Promise<void> | void) =>
    async () => {
      try {
        if (!disconnectFn) throw new Error('Disconnect function is null');
        await disconnectFn();
      } catch (error) {
        logger.error(`Error disconnecting from ${env} wallet`, error);
      }
    };

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: onClickDisconnect(
        ProtocolType.Ethereum,
        disconnectEvm,
      ),
      [ProtocolType.Sealevel]: onClickDisconnect(
        ProtocolType.Sealevel,
        disconnectSol,
      ),
      [ProtocolType.Cosmos]: onClickDisconnect(
        ProtocolType.Cosmos,
        disconnectCosmos,
      ),
      [ProtocolType.CosmosNative]: onClickDisconnect(
        ProtocolType.CosmosNative,
        disconnectCosmos,
      ),
      [ProtocolType.Starknet]: onClickDisconnect(
        ProtocolType.Starknet,
        disconnectStarknet,
      ),
      [ProtocolType.Radix]: onClickDisconnect(
        ProtocolType.Radix,
        disconnectRadix,
      ),
      [ProtocolType.Aleo]: onClickDisconnect(ProtocolType.Aleo, disconnectAleo),
    }),
    [
      disconnectEvm,
      disconnectSol,
      disconnectCosmos,
      disconnectStarknet,
      disconnectRadix,
      disconnectAleo,
    ],
  );
}

export function useActiveChains(multiProvider: MultiProtocolProvider): {
  chains: Record<KnownProtocolType, ActiveChainInfo>;
  readyChains: Array<ActiveChainInfo>;
} {
  const evmChain = useEthereumActiveChain(multiProvider);
  const solChain = useSolanaActiveChain(multiProvider);
  const cosmChain = useCosmosActiveChain(multiProvider);
  const starknetChain = useStarknetActiveChain(multiProvider);
  const radixChain = useRadixActiveChain(multiProvider);
  const aleoChain = useAleoActiveChain(multiProvider);

  const readyChains = useMemo(
    () =>
      [
        evmChain,
        solChain,
        cosmChain,
        starknetChain,
        radixChain,
        aleoChain,
      ].filter((c) => !!c.chainDisplayName),
    [evmChain, solChain, cosmChain, starknetChain, radixChain, aleoChain],
  );

  return useMemo(
    () => ({
      chains: {
        [ProtocolType.Ethereum]: evmChain,
        [ProtocolType.Sealevel]: solChain,
        [ProtocolType.Cosmos]: cosmChain,
        [ProtocolType.CosmosNative]: cosmChain,
        [ProtocolType.Starknet]: starknetChain,
        [ProtocolType.Radix]: radixChain,
        [ProtocolType.Aleo]: aleoChain,
      },
      readyChains,
    }),
    [
      evmChain,
      solChain,
      cosmChain,
      readyChains,
      starknetChain,
      radixChain,
      aleoChain,
    ],
  );
}

export function useTransactionFns(
  multiProvider: MultiProtocolProvider,
): Record<KnownProtocolType, ChainTransactionFns> {
  const {
    switchNetwork: onSwitchEvmNetwork,
    sendTransaction: onSendEvmTx,
    sendMultiTransaction: onSendMultiEvmTx,
  } = useEthereumTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchSolNetwork,
    sendTransaction: onSendSolTx,
    sendMultiTransaction: onSendMultiSolTx,
  } = useSolanaTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchCosmNetwork,
    sendTransaction: onSendCosmTx,
    sendMultiTransaction: onSendMultiCosmTx,
  } = useCosmosTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchStarknetNetwork,
    sendTransaction: onSendStarknetTx,
    sendMultiTransaction: onSendMultiStarknetTx,
  } = useStarknetTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchRadixNetwork,
    sendTransaction: onSendRadixTx,
    sendMultiTransaction: onSendMultiRadixTx,
  } = useRadixTransactionFns(multiProvider);
  const {
    switchNetwork: onSwitchAleoNetwork,
    sendTransaction: onSendAleoTx,
    sendMultiTransaction: onSendMultiAleoTx,
  } = useAleoTransactionFns(multiProvider);

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: {
        sendTransaction: onSendEvmTx,
        sendMultiTransaction: onSendMultiEvmTx,
        switchNetwork: onSwitchEvmNetwork,
      },
      [ProtocolType.Sealevel]: {
        sendTransaction: onSendSolTx,
        sendMultiTransaction: onSendMultiSolTx,
        switchNetwork: onSwitchSolNetwork,
      },
      [ProtocolType.Cosmos]: {
        sendTransaction: onSendCosmTx,
        sendMultiTransaction: onSendMultiCosmTx,
        switchNetwork: onSwitchCosmNetwork,
      },
      [ProtocolType.CosmosNative]: {
        sendTransaction: onSendCosmTx,
        sendMultiTransaction: onSendMultiCosmTx,
        switchNetwork: onSwitchCosmNetwork,
      },
      [ProtocolType.Starknet]: {
        sendTransaction: onSendStarknetTx,
        sendMultiTransaction: onSendMultiStarknetTx,
        switchNetwork: onSwitchStarknetNetwork,
      },
      [ProtocolType.Radix]: {
        sendTransaction: onSendRadixTx,
        sendMultiTransaction: onSendMultiRadixTx,
        switchNetwork: onSwitchRadixNetwork,
      },
      [ProtocolType.Aleo]: {
        sendTransaction: onSendAleoTx,
        sendMultiTransaction: onSendMultiAleoTx,
        switchNetwork: onSwitchAleoNetwork,
      },
    }),
    [
      onSendEvmTx,
      onSendSolTx,
      onSwitchEvmNetwork,
      onSwitchSolNetwork,
      onSendCosmTx,
      onSwitchCosmNetwork,
      onSendStarknetTx,
      onSwitchStarknetNetwork,
      onSendRadixTx,
      onSwitchRadixNetwork,
      onSendAleoTx,
      onSwitchAleoNetwork,
    ],
  );
}

export function useWatchAsset(
  multiProvider: MultiProtocolProvider,
): Record<KnownProtocolType, WatchAssetFns> {
  const { addAsset: evmAddAsset } = useEthereumWatchAsset(multiProvider);
  const { addAsset: solanaAddAsset } = useSolanaWatchAsset(multiProvider);
  const { addAsset: cosmosAddAsset } = useCosmosWatchAsset(multiProvider);
  const { addAsset: starknetAddAsset } = useStarknetWatchAsset(multiProvider);
  const { addAsset: radixAddAsset } = useRadixWatchAsset(multiProvider);
  const { addAsset: aleoAddAsset } = useAleoWatchAsset(multiProvider);

  return useMemo(
    () => ({
      [ProtocolType.Ethereum]: {
        addAsset: evmAddAsset,
      },
      [ProtocolType.Sealevel]: {
        addAsset: solanaAddAsset,
      },
      [ProtocolType.Cosmos]: {
        addAsset: cosmosAddAsset,
      },
      [ProtocolType.CosmosNative]: {
        addAsset: cosmosAddAsset,
      },
      [ProtocolType.Starknet]: {
        addAsset: starknetAddAsset,
      },
      [ProtocolType.Radix]: {
        addAsset: radixAddAsset,
      },
      [ProtocolType.Aleo]: {
        addAsset: aleoAddAsset,
      },
    }),
    [
      evmAddAsset,
      solanaAddAsset,
      cosmosAddAsset,
      starknetAddAsset,
      radixAddAsset,
      aleoAddAsset,
    ],
  );
}
