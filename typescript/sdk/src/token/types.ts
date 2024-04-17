import { z } from 'zod';

import {
  WarpRouteDeployConfigSchema,
  tokenRouterConfigSchema,
} from './schemas.js';

export type TokenRouterConfig = z.infer<typeof tokenRouterConfigSchema>;
export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;
