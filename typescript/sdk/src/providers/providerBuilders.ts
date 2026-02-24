import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { StargateClient } from '@cosmjs/stargate';
import { Connection } from '@solana/web3.js';
import { Provider } from 'ethers';
import { RpcProvider as StarknetRpcProvider } from 'starknet';
import { createPublicClient, http } from 'viem';
import { Provider as ZKProvider } from 'zksync-ethers';

import { AleoProvider as AleoSDKProvider } from '@hyperlane-xyz/aleo-sdk';
import { CosmosNativeProvider } from '@hyperlane-xyz/cosmos-sdk';
import { RadixProvider as RadixSDKProvider } from '@hyperlane-xyz/radix-sdk';
import { TronJsonRpcProvider } from '@hyperlane-xyz/tron-sdk';
import { ProtocolType, assert, isNumeric } from '@hyperlane-xyz/utils';

import { ChainMetadata, RpcUrl } from '../metadata/chainMetadataTypes.js';

import {
  AleoProvider,
  CosmJsNativeProvider,
  CosmJsProvider,
  CosmJsWasmProvider,
  EthersV5Provider,
  KnownProtocolType,
  ProviderType,
  RadixProvider,
  SolanaWeb3Provider,
  StarknetJsProvider,
  TypedProvider,
  ViemProvider,
  ZKSyncProvider,
} from './ProviderType.js';
import { HyperlaneSmartProvider } from './SmartProvider/SmartProvider.js';
import { ProviderRetryOptions } from './SmartProvider/types.js';
import { parseCustomRpcHeaders } from '../utils/provider.js';

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
  network: number | string,
): CosmJsNativeProvider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.CosmJsNative,
    provider: CosmosNativeProvider.connect(
      rpcUrls.map((rpc) => rpc.http),
      network,
    ),
  };
}

export function defaultStarknetJsProviderBuilder(
  rpcUrls: RpcUrl[],
): StarknetJsProvider {
  assert(rpcUrls.length, 'No RPC URLs provided');
  const { url, headers } = parseCustomRpcHeaders(rpcUrls[0].http);
  const provider = new StarknetRpcProvider({
    nodeUrl: url,
    headers,
  });
  return { provider, type: ProviderType.Starknet };
}

export function defaultZKSyncProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
): ZKSyncProvider {
  assert(rpcUrls.length, 'No RPC URLs provided');
  const url = rpcUrls[0].http;
  const provider = new ZKProvider(url, network as any);
  return { type: ProviderType.ZkSync, provider };
}

export function defaultRadixProviderBuilder(
  rpcUrls: RpcUrl[],
  network: string | number,
): RadixProvider {
  assert(isNumeric(network), 'Radix requires a numeric network id');
  const networkId = parseInt(network.toString(), 10);
  const provider = new RadixSDKProvider({
    rpcUrls: rpcUrls.map((rpc) => rpc.http),
    networkId,
  });
  return { provider, type: ProviderType.Radix };
}

export function defaultAleoProviderBuilder(
  rpcUrls: RpcUrl[],
  network: string | number,
): AleoProvider {
  const provider = new AleoSDKProvider(
    rpcUrls.map((rpc) => rpc.http),
    network,
  );
  return { provider, type: ProviderType.Aleo };
}

/**
 * Returns an ethers-compatible TronJsonRpcProvider for use in MultiProvider.
 * This handles Tron's missing eth_getTransactionCount and returns the raw provider.
 */
export function defaultTronEthersProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): providers.Provider {
  assert(rpcUrls.length > 0, 'At least one RPC URL required for Tron');
  return new TronJsonRpcProvider(rpcUrls[0].http);
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): Provider {
  return defaultEthersV5ProviderBuilder(rpcUrls, _network).provider;
}

export function defaultZKProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): ZKProvider {
  return defaultZKSyncProviderBuilder(rpcUrls, _network).provider;
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
  [ProviderType.ZkSync]: defaultZKSyncProviderBuilder,
  [ProviderType.Radix]: defaultRadixProviderBuilder,
  [ProviderType.Aleo]: defaultAleoProviderBuilder,
};

export const protocolToDefaultProviderBuilder: Record<
  KnownProtocolType,
  ProviderBuilderFn<TypedProvider>
> = {
  [ProtocolType.Ethereum]: defaultEthersV5ProviderBuilder,
  [ProtocolType.Sealevel]: defaultSolProviderBuilder,
  [ProtocolType.Cosmos]: defaultCosmJsWasmProviderBuilder,
  [ProtocolType.CosmosNative]: defaultCosmJsNativeProviderBuilder,
  [ProtocolType.Starknet]: defaultStarknetJsProviderBuilder,
  [ProtocolType.Radix]: defaultRadixProviderBuilder,
  [ProtocolType.Aleo]: defaultAleoProviderBuilder,
};
