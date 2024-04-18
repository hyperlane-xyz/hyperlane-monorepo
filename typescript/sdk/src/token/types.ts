import { z } from 'zod';

import {
  TokenRouterConfigSchema,
  WarpRouteDeployConfigSchema,
} from './schemas.js';

export type TokenRouterConfig = z.infer<typeof TokenRouterConfigSchema>;
export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;
