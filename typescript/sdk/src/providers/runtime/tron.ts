import type { ProviderBuilderMap } from '../defaultProviderBuilderMaps.js';
import { ProviderType } from '../ProviderType.js';
import { defaultTronProviderBuilder } from '../builders/tron.js';

export const tronRuntimeProviderBuilders: Partial<ProviderBuilderMap> = {
  [ProviderType.Tron]: defaultTronProviderBuilder,
};
