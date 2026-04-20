import { RadixProvider as RadixSDKProvider } from '@hyperlane-xyz/radix-sdk/runtime';
import { assert, isNumeric } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type { RadixProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultRadixProviderBuilder: ProviderBuilderFn<RadixProvider> = (
  rpcUrls: RpcUrl[],
  network: string | number,
) => {
  assert(rpcUrls.length > 0, 'Radix requires at least one rpcUrl');
  assert(isNumeric(network), 'Radix requires a numeric network id');
  const networkId = parseInt(network.toString(), 10);
  const provider = new RadixSDKProvider({
    rpcUrls: rpcUrls.map((rpc) => rpc.http),
    networkId,
  });
  return { provider, type: ProviderType.Radix };
};
