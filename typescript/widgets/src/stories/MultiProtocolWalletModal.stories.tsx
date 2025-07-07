import { ChakraProvider } from '@chakra-ui/react';
import { ChainProvider } from '@cosmos-kit/react';
import '@interchain-ui/react/styles';
import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  Logger,
  RadixDappToolkit,
  RadixNetwork,
} from '@radixdlt/radix-dapp-toolkit';
import { RainbowKitProvider } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { clusterApiUrl } from '@solana/web3.js';
import { sepolia } from '@starknet-react/chains';
import { StarknetConfig, publicProvider } from '@starknet-react/core';
import { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PropsWithChildren, useState } from 'react';
import { WagmiProvider, createConfig, http } from 'wagmi';

import { cosmoshub, ethereum, solanamainnet } from '@hyperlane-xyz/registry';
import { MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { AccountList } from '../walletIntegrations/AccountList.js';
import { ConnectWalletButton } from '../walletIntegrations/ConnectWalletButton.js';
import { MultiProtocolWalletModal } from '../walletIntegrations/MultiProtocolWalletModal.js';
import { getCosmosKitChainConfigs } from '../walletIntegrations/cosmos.js';
import { getWagmiChainConfigs } from '../walletIntegrations/ethereum.js';
import { AccountProvider } from '../walletIntegrations/radix/AccountContext.js';
import { GatewayApiProvider } from '../walletIntegrations/radix/GatewayApiProvider.js';
import { RdtProvider } from '../walletIntegrations/radix/RdtProvider.js';

const multiProvider = new MultiProtocolProvider({
  ethereum,
  cosmoshub,
  solanamainnet,
});

function MinimalDapp({ protocols }: { protocols?: ProtocolType[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  return (
    <EthereumWalletProvider>
      <CosmosWalletProvider>
        <SolanaWalletProvider>
          <StarknetWalletProvider>
            <RadixWalletProvider>
              <div className="htw-space-y-4">
                <h1>CONNECT BUTTON</h1>
                <ConnectWalletButton
                  multiProvider={multiProvider}
                  onClickWhenConnected={open}
                  onClickWhenUnconnected={open}
                />
                <h1>ACCOUNT SUMMARY</h1>
                <AccountList
                  multiProvider={multiProvider}
                  onClickConnectWallet={open}
                />
              </div>
              <MultiProtocolWalletModal
                isOpen={isOpen}
                close={close}
                protocols={protocols}
              />
            </RadixWalletProvider>
          </StarknetWalletProvider>
        </SolanaWalletProvider>
      </CosmosWalletProvider>
    </EthereumWalletProvider>
  );
}

const wagmiConfig = createConfig({
  chains: [getWagmiChainConfigs(multiProvider)[0]],
  transports: { [ethereum.chainId]: http() },
});

function EthereumWalletProvider({ children }: PropsWithChildren<unknown>) {
  const queryClient = new QueryClient();

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

const cosmosKitConfig = getCosmosKitChainConfigs(multiProvider);

function CosmosWalletProvider({ children }: PropsWithChildren<unknown>) {
  return (
    <ChakraProvider>
      <ChainProvider
        chains={cosmosKitConfig.chains}
        assetLists={cosmosKitConfig.assets}
        wallets={[]}
      >
        {children}
      </ChainProvider>
    </ChakraProvider>
  );
}

function SolanaWalletProvider({ children }: PropsWithChildren<unknown>) {
  return (
    <ConnectionProvider endpoint={clusterApiUrl(WalletAdapterNetwork.Mainnet)}>
      <WalletProvider wallets={[]}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function StarknetWalletProvider({ children }: PropsWithChildren<unknown>) {
  return (
    <StarknetConfig chains={[sepolia]} provider={publicProvider()}>
      {children}
    </StarknetConfig>
  );
}

function RadixWalletProvider({ children }: PropsWithChildren<unknown>) {
  // TODO: RADIX
  const rdt = RadixDappToolkit({
    networkId: RadixNetwork.Mainnet,
    applicationVersion: '1.0.0',
    applicationName: 'Radix Web3 dApp',
    applicationDappDefinitionAddress:
      'account_rdx12y7md4spfq5qy7e3mfjpa52937uvkxf0nmydsu5wydkkxw3qx6nghn',
    logger: Logger(1),
  });

  const gatewayApi = GatewayApiClient.initialize(rdt.gatewayApi.clientConfig);

  return (
    <RdtProvider value={rdt}>
      <GatewayApiProvider value={gatewayApi}>
        <AccountProvider>{children}</AccountProvider>
      </GatewayApiProvider>
    </RdtProvider>
  );
}

const meta = {
  title: 'MultiProtocolWalletModal',
  component: MinimalDapp,
} satisfies Meta<typeof MinimalDapp>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultPicker = {
  args: {},
} satisfies Story;

export const EvmOnlyPicker = {
  args: { protocols: [ProtocolType.Ethereum] },
} satisfies Story;
