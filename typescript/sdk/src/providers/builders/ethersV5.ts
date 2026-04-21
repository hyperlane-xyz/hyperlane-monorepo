import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';
import type {
  EthersV5Provider,
  GnosisTxBuilderProvider,
} from '../ProviderType.js';
import { ProviderType } from '../ProviderType.js';
import { HyperlaneSmartProvider } from '../SmartProvider/SmartProvider.js';
import type { ProviderRetryOptions } from '../SmartProvider/types.js';

import type { ProviderBuilderFn } from './types.js';

const DEFAULT_RETRY_OPTIONS: ProviderRetryOptions = {
  maxRetries: 3,
  baseRetryDelayMs: 250,
};

export const defaultEthersV5ProviderBuilder: ProviderBuilderFn<
  EthersV5Provider
> = (
  rpcUrls: RpcUrl[],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
) => {
  const provider = new HyperlaneSmartProvider(
    network,
    rpcUrls,
    undefined,
    retryOverride || DEFAULT_RETRY_OPTIONS,
  );
  return { type: ProviderType.EthersV5, provider };
};

export const defaultGnosisTxBuilderProviderBuilder: ProviderBuilderFn<
  GnosisTxBuilderProvider
> = (rpcUrls, network, retryOverride) => ({
  type: ProviderType.GnosisTxBuilder,
  provider: defaultEthersV5ProviderBuilder(rpcUrls, network, retryOverride)
    .provider,
});

export function defaultFuelProviderBuilder(
  rpcUrls: RpcUrl[],
  _network: number | string,
): EthersV5Provider {
  if (!rpcUrls.length) throw new Error('No RPC URLs provided');
  throw new Error('TODO fuel support');
}

// Kept for backwards compatibility
export function defaultProviderBuilder(
  rpcUrls: RpcUrl[],
  network: number | string,
): EthersV5Provider['provider'] {
  return defaultEthersV5ProviderBuilder(rpcUrls, network).provider;
}
