import { z } from 'zod';

import {
  DerivedIcaRouterConfigSchema,
  IcaRouterConfigSchema,
} from './schemas.js';

export type IcaRouterConfig = z.infer<typeof IcaRouterConfigSchema>;

export type DerivedIcaRouterConfig = z.infer<
  typeof DerivedIcaRouterConfigSchema
>;
