import { z } from 'zod';

import { OffchainLookupIsmConfigSchema } from '../ism/types.js';
import { RouterConfigSchema } from '../router/types.js';

export const IcaRouterConfigSchema = RouterConfigSchema.extend({
  commitmentIsm: OffchainLookupIsmConfigSchema,
});

export type IcaRouterConfig = z.infer<typeof IcaRouterConfigSchema>;

export const DerivedIcaRouterConfigSchema = IcaRouterConfigSchema.extend({
  address: z.string(),
});

export type DerivedIcaRouterConfig = z.infer<
  typeof DerivedIcaRouterConfigSchema
>;
