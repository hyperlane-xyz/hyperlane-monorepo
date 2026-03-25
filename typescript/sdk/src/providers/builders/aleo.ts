import { AleoProvider as AleoSDKProvider } from '@hyperlane-xyz/aleo-sdk/runtime';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { AleoProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultAleoProviderBuilder: ProviderBuilderFn<AleoProvider> = (
  rpcUrls: RpcUrl[],
  network: string | number,
) => {
  const provider = new AleoSDKProvider(
    rpcUrls.map((rpc) => rpc.http),
    network,
  );
  return { provider, type: ProviderType.Aleo };
};
