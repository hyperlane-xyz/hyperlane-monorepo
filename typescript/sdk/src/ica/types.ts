import { z } from 'zod';

import { OffchainLookupIsmConfigSchema } from '../ism/types.js';
import { ZHash } from '../metadata/customZodTypes.js';
import { RouterConfigSchema } from '../router/types.js';

/**
 * Schema for fee token approval configuration.
 * Used to pre-approve ERC-20 fee tokens for hooks (e.g., IGP inside aggregation hooks).
 */
export const FeeTokenApprovalSchema = z.object({
  /** ERC-20 fee token address */
  feeToken: ZHash,
  /** Hook address to approve (e.g., IGP inside StaticAggregationHook) */
  hook: ZHash,
});

export type FeeTokenApproval = z.infer<typeof FeeTokenApprovalSchema>;

export const IcaRouterConfigSchema = RouterConfigSchema.extend({
  commitmentIsm: OffchainLookupIsmConfigSchema,
  /**
   * Optional: Pre-approve fee tokens for hooks.
   * Use this when the ICA router will be used with ERC-20 fee tokens and
   * aggregation hooks containing an IGP as a child hook.
   */
  feeTokenApprovals: z.array(FeeTokenApprovalSchema).optional(),
});

export type IcaRouterConfig = z.infer<typeof IcaRouterConfigSchema>;

export const DerivedIcaRouterConfigSchema = IcaRouterConfigSchema.extend({
  address: z.string(),
});

export type DerivedIcaRouterConfig = z.infer<
  typeof DerivedIcaRouterConfigSchema
>;
