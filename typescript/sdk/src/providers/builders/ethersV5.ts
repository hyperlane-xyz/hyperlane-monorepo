import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type {
  EthersV5Provider,
  GnosisTxBuilderProvider,
} from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';
import { HyperlaneSmartProvider } from '../SmartProvider/SmartProvider.js';
import type { SmartProviderOptions } from '../SmartProvider/types.js';

import type { ProviderBuilderFn } from './types.js';

const DEFAULT_RETRY_OPTIONS: SmartProviderOptions = {
  maxRetries: 3,
  baseRetryDelayMs: 250,
};

export const defaultEthersV5ProviderBuilder: ProviderBuilderFn<
  EthersV5Provider
> = (metadata: ChainMetadata, retryOverride?: SmartProviderOptions) => {
  const provider = new HyperlaneSmartProvider(
    metadata.chainId,
    metadata.rpcUrls,
    undefined,
    retryOverride || DEFAULT_RETRY_OPTIONS,
  );
  return { type: ProviderType.EthersV5, provider };
};

export const defaultGnosisTxBuilderProviderBuilder: ProviderBuilderFn<
  GnosisTxBuilderProvider
> = (metadata, retryOverride) => ({
  type: ProviderType.GnosisTxBuilder,
  provider: defaultEthersV5ProviderBuilder(metadata, retryOverride).provider,
});

export function defaultFuelProviderBuilder(
  metadata: ChainMetadata,
): EthersV5Provider {
  if (!metadata.rpcUrls.length) throw new Error('No RPC URLs provided');
  throw new Error('TODO fuel support');
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  metadata: ChainMetadata,
): EthersV5Provider['provider'] {
  return defaultEthersV5ProviderBuilder(metadata).provider;
}
