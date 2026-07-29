import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import type { TypedProvider } from '../ProviderType.js';
import type { SmartProviderOptions } from '../SmartProvider/types.js';

export type ProviderBuilderFn<P> = (
  metadata: ChainMetadata,
  retryOverride?: SmartProviderOptions,
) => P;

export type TypedProviderBuilderFn = ProviderBuilderFn<TypedProvider>;
