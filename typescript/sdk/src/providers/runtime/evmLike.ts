import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';

import { evmRuntimeProviderBuilders } from './evm.js';
import { tronRuntimeProviderBuilders } from './tron.js';

export const evmLikeRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  ...evmRuntimeProviderBuilders,
  ...tronRuntimeProviderBuilders,
};
