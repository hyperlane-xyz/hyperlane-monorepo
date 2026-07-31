import type { RadixProvider as RadixSDKProvider } from '@hyperlane-xyz/radix-sdk/runtime';
import { LazyAsync, assert, isNumeric } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { RadixProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

interface RadixProviderOptions {
  rpcUrls: string[];
  networkId: number;
  chainMetadata: ChainMetadata;
}

type RadixProviderConstructor = new (
  options: RadixProviderOptions,
) => RadixSDKProvider;

interface RadixRuntimeModule {
  RadixProvider: RadixProviderConstructor;
}

type RadixProviderLoader = () => Promise<RadixRuntimeModule>;

const loadRadixProvider: RadixProviderLoader = () =>
  import('@hyperlane-xyz/radix-sdk/runtime');

function createAsyncMethodProxy<T extends object>(
  getTarget: () => Promise<T>,
): T {
  // CAST: The proxy preserves RadixProvider's async method surface while
  // deferring construction; getRpcUrls is handled synchronously by its caller.
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
              `Radix provider property ${String(property)} is not callable`,
            );
          }
          return Reflect.apply(method, target, args);
        };
      },
    },
  ) as T;
}

export function createLazyRadixProvider(
  metadata: ChainMetadata,
  loadProvider: RadixProviderLoader = loadRadixProvider,
): RadixSDKProvider {
  const { rpcUrls, chainId } = metadata;
  assert(rpcUrls.length > 0, 'Radix requires at least one rpcUrl');
  assert(isNumeric(chainId), 'Radix requires a numeric network id');

  const urls = rpcUrls.map((rpc) => rpc.http);
  const networkId = parseInt(chainId.toString(), 10);
  const provider = new LazyAsync(() =>
    loadProvider().then(
      ({ RadixProvider }) =>
        new RadixProvider({
          rpcUrls: urls,
          networkId,
          chainMetadata: metadata,
        }),
    ),
  );
  const asyncProvider = createAsyncMethodProxy(() => provider.get());

  return new Proxy(asyncProvider, {
    get: (target, property, receiver) => {
      if (property === 'getRpcUrls') return () => urls;
      return Reflect.get(target, property, receiver);
    },
  });
}

export const defaultRadixProviderBuilder: ProviderBuilderFn<RadixProvider> = (
  metadata: ChainMetadata,
) => {
  const provider = createLazyRadixProvider(metadata);
  return { provider, type: ProviderType.Radix };
};
