import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { TypedProvider } from '../ProviderType.js';
import type { SmartProviderOptions } from '../SmartProvider/types.js';

export type ProviderBuilderFn<P> = (
  rpcUrls: ChainMetadata['rpcUrls'],
  network: number | string,
  retryOverride?: SmartProviderOptions,
) => P;

export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;
