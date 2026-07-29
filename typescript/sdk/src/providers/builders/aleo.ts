import { AleoProvider as AleoSDKProvider } from '@hyperlane-xyz/aleo-sdk/runtime';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { AleoProvider } from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';

import type { ProviderBuilderFn } from './types.js';

export const defaultAleoProviderBuilder: ProviderBuilderFn<AleoProvider> = (
  metadata: ChainMetadata,
) => {
  const provider = new AleoSDKProvider(
    metadata.rpcUrls.map((rpc) => rpc.http),
    metadata.chainId,
    metadata,
  );
  return { provider, type: ProviderType.Aleo };
};
