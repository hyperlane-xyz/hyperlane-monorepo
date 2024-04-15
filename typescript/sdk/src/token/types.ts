import { z } from 'zod';

import { WarpRouteDeployConfigSchema } from './schemas.js';

export type WarpRouteDeployConfig = z.infer<typeof WarpRouteDeployConfigSchema>;
