import { Connection } from '@solana/web3.js';
import { providers } from 'ethers';
import { createPublicClient, http } from 'viem';

import { ProtocolType, isNumeric } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes';

import {
  EthersV5Provider,
  ProviderType,
  SolanaWeb3Provider,
  TypedProvider,
  ViemProvider,
} from './ProviderType';
import { RetryJsonRpcProvider, RetryProviderOptions } from './RetryProvider';

export type ProviderBuilderFn<P> = (
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: RetryProviderOptions,
) => P;
export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;

export const DEFAULT_RETRY_OPTIONS: RetryProviderOptions = {
  maxRequests: 3,
  baseRetryMs: 250,
};

export function defaultEthersV5ProviderBuilder(
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: RetryProviderOptions,
): EthersV5Provider {
  const createProvider = (r: ChainMetadata['rpcUrls'][number]) => {
    const retry = r.retry || retryOverride;
    return retry
      ? new RetryJsonRpcProvider(retry, r.http, network)
      : new providers.StaticJsonRpcProvider(r.http, network);
  };
  let provider: providers.Provider;
  if (rpcUrls.length > 1) {
    provider = new providers.FallbackProvider(rpcUrls.map(createProvider), 1);
  } else if (rpcUrls.length === 1) {
    provider = createProvider(rpcUrls[0]);
  } else {
    throw new Error('No RPC URLs provided');
  }
  return { type: ProviderType.EthersV5, provider };
}

// export function defaultEthersV6ProviderBuilder(
//   rpcUrls: ChainMetadata['rpcUrls'],
//   network: number | string,
// ): EthersV6Provider {
//   // TODO add support for retry providers here
//   if (!rpcUrls.length) throw new Error('No RPC URLs provided');
//   return {
//     type: ProviderType.EthersV6,
//     provider: new Ev6JsonRpcProvider(rpcUrls[0].http, network),
//   };
// }

export function defaultViemProviderBuilder(
  rpcUrls: ChainMetadata['rpcUrls'],
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
  rpcUrls: ChainMetadata['rpcUrls'],
  _network: number | string,
): SolanaWeb3Provider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  return {
    type: ProviderType.SolanaWeb3,
    provider: new Connection(rpcUrls[0].http, 'confirmed'),
  };
}

export function defaultFuelProviderBuilder(
  rpcUrls: ChainMetadata['rpcUrls'],
  _network: number | string,
): EthersV5Provider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  throw new Error('TODO fuel support');
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  rpcUrls: ChainMetadata['rpcUrls'],
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
  // [ProviderType.EthersV6]: defaultEthersV6ProviderBuilder,
  [ProviderType.Viem]: defaultViemProviderBuilder,
  [ProviderType.SolanaWeb3]: defaultSolProviderBuilder,
};

export const protocolToDefaultProviderBuilder: Record<
  ProtocolType,
  ProviderBuilderFn<TypedProvider>
> = {
  [ProtocolType.Ethereum]: defaultEthersV5ProviderBuilder,
  [ProtocolType.Sealevel]: defaultSolProviderBuilder,
  [ProtocolType.Fuel]: defaultFuelProviderBuilder,
};
