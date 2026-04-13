import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { TypedProvider } from '../ProviderType.js';
import type { ProviderRetryOptions } from '../SmartProvider/types.js';

export type ProviderBuilderFn<P> = (
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: ProviderRetryOptions,
) => P;

export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;
