import type { AleoProvider as AleoSDKProvider } from '@hyperlane-xyz/aleo-sdk/runtime';
import { AleoNetworkId } from '@hyperlane-xyz/aleo-sdk/constants';
import { LazyAsync } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { AleoProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

type AleoProviderConstructor = new (
  rpcUrls: string[],
  network: string | number,
  metadata: ChainMetadata,
) => AleoSDKProvider;

interface AleoRuntimeModule {
  AleoProvider: AleoProviderConstructor;
}

type AleoProviderLoader = (
  network: string | number,
) => Promise<AleoRuntimeModule>;

const loadAleoProvider: AleoProviderLoader = (network) => {
  switch (+network) {
    case AleoNetworkId.MAINNET:
      return import('@hyperlane-xyz/aleo-sdk/runtime/mainnet');
    case AleoNetworkId.TESTNET:
      return import('@hyperlane-xyz/aleo-sdk/runtime/testnet');
    default:
      throw new Error(`Unsupported Aleo network id ${network}`);
  }
};

function createAsyncMethodProxy<T extends object>(
  getTarget: () => Promise<T>,
): T {
  // CAST: The proxy preserves T's async method surface while deferring target
  // creation; synchronous Aleo methods are handled explicitly by its caller.
  return new Proxy(
    {},
    {
      get: (_, property) => {
        if (property === 'then') return undefined;
        return async (...args: unknown[]) => {
          const target = await getTarget();
          const method = Reflect.get(target, property);
          if (typeof method !== 'function') {
            throw new Error(
              `Aleo provider property ${String(property)} is not callable`,
            );
          }
          return Reflect.apply(method, target, args);
        };
      },
    },
  ) as T;
}

export function createLazyAleoProvider(
  metadata: ChainMetadata,
  loadProvider: AleoProviderLoader = loadAleoProvider,
): AleoSDKProvider {
  const { chainId: network } = metadata;
  const rpcUrls = metadata.rpcUrls.map((rpc) => rpc.http);
  const normalizedRpcUrls = rpcUrls.map((url) =>
    url.replaceAll('/testnet', '').replaceAll('/mainnet', ''),
  );
  const provider = new LazyAsync(() =>
    loadProvider(network).then(
      ({ AleoProvider }) => new AleoProvider(rpcUrls, network, metadata),
    ),
  );
  const getProvider = () => provider.get();
  const asyncProvider = createAsyncMethodProxy(getProvider);

  return new Proxy(asyncProvider, {
    get: (target, property, receiver) => {
      if (property === 'getRpcUrls') return () => normalizedRpcUrls;
      if (property === 'getAleoClient') {
        return () =>
          createAsyncMethodProxy(async () =>
            (await getProvider()).getAleoClient(),
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export const defaultAleoProviderBuilder: ProviderBuilderFn<AleoProvider> = (
  metadata: ChainMetadata,
) => {
  const provider = createLazyAleoProvider(metadata);
  return { provider, type: ProviderType.Aleo };
};
