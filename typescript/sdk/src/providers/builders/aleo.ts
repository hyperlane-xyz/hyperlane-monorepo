import type { AleoProvider as AleoSDKProvider } from '@hyperlane-xyz/aleo-sdk/runtime';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { AleoProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

type AleoProviderConstructor = new (
  rpcUrls: string[],
  network: string | number,
) => AleoSDKProvider;

interface AleoRuntimeModule {
  AleoProvider: AleoProviderConstructor;
}

type AleoProviderLoader = () => Promise<AleoRuntimeModule>;

const loadAleoProvider: AleoProviderLoader = () =>
  import('@hyperlane-xyz/aleo-sdk/runtime');

// Aleo's public provider operations are async, so keep the synchronous builder
// contract while loading the large protocol runtime on the first operation.
function createAsyncMethodProxy<T extends object>(
  getTarget: () => Promise<T>,
): T {
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
  rpcUrls: string[],
  network: string | number,
  loadProvider: AleoProviderLoader = loadAleoProvider,
): AleoSDKProvider {
  const normalizedRpcUrls = rpcUrls.map((url) =>
    url.replaceAll('/testnet', '').replaceAll('/mainnet', ''),
  );
  let providerPromise: Promise<AleoSDKProvider> | undefined;
  const getProvider = () =>
    (providerPromise ??= loadProvider().then(
      ({ AleoProvider }) => new AleoProvider(rpcUrls, network),
    ));
  const asyncProvider = createAsyncMethodProxy(getProvider);

  return new Proxy(asyncProvider, {
    get: (target, property, receiver) => {
      if (property === 'getRpcUrls') return () => normalizedRpcUrls;
      if (property === 'getAleoClient') {
        // Network-client operations are async too; preserve the nested API shape.
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
  rpcUrls: RpcUrl[],
  network: string | number,
) => {
  const provider = createLazyAleoProvider(
    rpcUrls.map((rpc) => rpc.http),
    network,
  );
  return { provider, type: ProviderType.Aleo };
};
