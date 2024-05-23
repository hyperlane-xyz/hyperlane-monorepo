import { z } from 'zod';

import {
  TokenMetadataSchema,
  TokenRouterConfigSchema,
  WarpRouteDeployConfigSchema,
} from './schemas.js';

export type TokenMetadata = z.infer<typeof TokenMetadataSchema>;
export type TokenRouterConfig = z.infer<typeof TokenRouterConfigSchema>;
export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;
