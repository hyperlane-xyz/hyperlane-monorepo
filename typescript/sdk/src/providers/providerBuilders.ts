import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { StargateClient } from '@cosmjs/stargate';
import { Connection } from '@solana/web3.js';
import { providers } from 'ethers';
import { RpcProvider as StarknetRpcProvider } from 'starknet';
import { createPublicClient, http } from 'viem';

import { HyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { ProtocolType, isNumeric } from '@hyperlane-xyz/utils';

import { ChainMetadata, RpcUrl } from '../metadata/chainMetadataTypes.js';

import {
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
  StarknetJsProvider,
  TypedProvider,
  ViemProvider,
} from './ProviderType.js';
import { HyperlaneSmartProvider } from './SmartProvider/SmartProvider.js';
import { ProviderRetryOptions } from './SmartProvider/types.js';

export type ProviderBuilderFn<P> = (
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
) => P;
export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;

const DEFAULT_RETRY_OPTIONS: ProviderRetryOptions = {
  maxRetries: 3,
  baseRetryDelayMs: 250,
};

export function defaultEthersV5ProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
): EthersV5Provider {
  const provider = new HyperlaneSmartProvider(
    network,
    rpcUrls,
    undefined,
    retryOverride || DEFAULT_RETRY_OPTIONS,
  );
  return { type: ProviderType.EthersV5, provider };
}

export function defaultViemProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
): ViemProvider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  if (!isNumeric(network)) throw new Error('Viem requires a numeric network');
  const id = parseInt(network.toString(), 10);
  const name = network.toString(); // TODO get more descriptive name
  const url = rpcUrls[0].http;
  const client = createPublicClient({
    chain: {
      id,
      name,
      network: name,
      nativeCurrency: { name: '', symbol: '', decimals: 0 },
      rpcUrls: { default: { http: [url] }, public: { http: [url] } },
    },
    transport: http(rpcUrls[0].http),
  });
  return { type: ProviderType.Viem, provider: client };
}

export function defaultSolProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): SolanaWeb3Provider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.SolanaWeb3,
    provider: new Connection(rpcUrls[0].http, 'confirmed'),
  };
}

export function defaultFuelProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): EthersV5Provider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  throw new Error('TODO fuel support');
}

export function defaultCosmJsProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): CosmJsProvider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.CosmJs,
    provider: StargateClient.connect(rpcUrls[0].http),
  };
}

export function defaultCosmJsWasmProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): CosmJsWasmProvider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.CosmJsWasm,
    provider: CosmWasmClient.connect(rpcUrls[0].http),
  };
}

export function defaultCosmJsNativeProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): CosmJsNativeProvider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.CosmJsNative,
    provider: HyperlaneModuleClient.connect(rpcUrls[0].http),
  };
}

export function defaultStarknetJsProviderBuilder(
  rpcUrls: RpcUrl[],
): StarknetJsProvider {
  const provider = new StarknetRpcProvider({
    nodeUrl: rpcUrls[0].http,
  });
  return { provider, type: ProviderType.Starknet };
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): providers.Provider {
  return defaultEthersV5ProviderBuilder(rpcUrls, _network).provider;
}

export type ProviderBuilderMap = Record<
  ProviderType,
  ProviderBuilderFn<TypedProvider>
>;
export const defaultProviderBuilderMap: ProviderBuilderMap = {
  [ProviderType.EthersV5]: defaultEthersV5ProviderBuilder,
  [ProviderType.GnosisTxBuilder]: defaultEthersV5ProviderBuilder,
  [ProviderType.Viem]: defaultViemProviderBuilder,
  [ProviderType.SolanaWeb3]: defaultSolProviderBuilder,
  [ProviderType.CosmJs]: defaultCosmJsProviderBuilder,
  [ProviderType.CosmJsWasm]: defaultCosmJsWasmProviderBuilder,
  [ProviderType.CosmJsNative]: defaultCosmJsNativeProviderBuilder,
  [ProviderType.Starknet]: defaultStarknetJsProviderBuilder,
};

export const protocolToDefaultProviderBuilder: Record<
  ProtocolType,
  ProviderBuilderFn<TypedProvider>
> = {
  [ProtocolType.Ethereum]: defaultEthersV5ProviderBuilder,
  [ProtocolType.Sealevel]: defaultSolProviderBuilder,
  [ProtocolType.Cosmos]: defaultCosmJsWasmProviderBuilder,
  [ProtocolType.CosmosNative]: defaultCosmJsNativeProviderBuilder,
  [ProtocolType.Starknet]: defaultStarknetJsProviderBuilder,
};
