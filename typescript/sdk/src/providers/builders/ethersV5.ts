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

const LOCAL_POLLING_INTERVAL_MS = 100;
const DEFAULT_POLLING_INTERVAL_MS = 4000;
const LOOPBACK_HOSTS = new Set(['localhost', '[::1]']);
const IPV4_LOOPBACK_HOST = /^127(?:\.\d{1,3}){3}$/;

export const defaultEthersV5ProviderBuilder: ProviderBuilderFn<
  EthersV5Provider
> = (metadata: ChainMetadata, retryOverride?: SmartProviderOptions) => {
  const provider = new HyperlaneSmartProvider(
    metadata.chainId,
    metadata.rpcUrls,
    undefined,
    retryOverride || DEFAULT_RETRY_OPTIONS,
  );
  // Local dev chains mine immediately. Configure the shared builder so CLI
  // subprocesses also avoid ethers' default four-second confirmation polling.
  if (
    metadata.rpcUrls.length > 0 &&
    metadata.rpcUrls.every(({ http }) => {
      // URL normalizes and validates IPv4 addresses before this check.
      const { hostname } = new URL(http);
      return LOOPBACK_HOSTS.has(hostname) || IPV4_LOOPBACK_HOST.test(hostname);
    })
  ) {
    provider.pollingInterval = LOCAL_POLLING_INTERVAL_MS;
  } else if (metadata.blocks?.estimateBlockTime) {
    // Follow the estimated block cadence, capped at ethers' default interval.
    // Ethers requires a positive integer number of milliseconds.
    provider.pollingInterval = Math.min(
      DEFAULT_POLLING_INTERVAL_MS,
      Math.max(1, Math.round(metadata.blocks.estimateBlockTime * 1000)),
    );
  }
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
