import { z } from 'zod';

import { WithAddress } from '@hyperlane-xyz/utils';

import { OffchainLookupIsmConfigSchema } from '../ism/types.js';
import { RouterConfigSchema } from '../router/types.js';

export const IcaRouterConfigSchema = RouterConfigSchema.extend({
  commitmentIsm: OffchainLookupIsmConfigSchema.optional(),
});

export type IcaRouterConfig = z.infer<typeof IcaRouterConfigSchema>;

// just an alias
export const DerivedIcaRouterConfigSchema = IcaRouterConfigSchema;

export type DerivedIcaRouterConfig = WithAddress<
  z.infer<typeof DerivedIcaRouterConfigSchema>
>;
