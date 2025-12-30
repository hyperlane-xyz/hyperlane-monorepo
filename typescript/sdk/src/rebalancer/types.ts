import { z } from 'zod';

export enum RebalancerStrategyOptions {
  Weighted = 'weighted',
  MinAmount = 'minAmount',
  CollateralDeficit = 'collateralDeficit',
  Composite = 'composite',
}

// Weighted strategy config schema
export const RebalancerWeightedChainConfigSchema = z.object({
  weight: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
  tolerance: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
});

export enum RebalancerMinAmountType {
  Absolute = 'absolute',
  Relative = 'relative',
}

export const RebalancerMinAmountConfigSchema = z.object({
  min: z.string().or(z.number()),
  target: z.string().or(z.number()),
  type: z.nativeEnum(RebalancerMinAmountType),
});

// Base chain config with common properties
const RebalancerBridgeConfigSchema = z.object({
  bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
  bridgeMinAcceptedAmount: z.string().or(z.number()).optional(),
  bridgeLockTime: z
    .number()
    .positive()
    .transform((val) => val * 1_000)
    .describe('Expected time in seconds for bridge to process a transfer'),
  bridgeIsWarp: z
    .boolean()
    .optional()
    .describe('True if the bridge is another Warp Route'),
});

export const RebalancerBaseChainConfigSchema =
  RebalancerBridgeConfigSchema.extend({
    override: z
      .record(z.string(), RebalancerBridgeConfigSchema.partial().passthrough())
      .optional(),
  });

// Schemas for strategy-specific chain configs
const WeightedChainConfigSchema = RebalancerBaseChainConfigSchema.extend({
  weighted: RebalancerWeightedChainConfigSchema,
});

const MinAmountChainConfigSchema = RebalancerBaseChainConfigSchema.extend({
  minAmount: RebalancerMinAmountConfigSchema,
});

// CollateralDeficit strategy config schema
export const RebalancerCollateralDeficitChainConfigSchema = z.object({
  bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
  buffer: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val))
    .describe('Buffer amount to add to deficit for headroom (in token units)'),
});

const CollateralDeficitChainConfigSchema =
  RebalancerBaseChainConfigSchema.extend({
    collateralDeficit: RebalancerCollateralDeficitChainConfigSchema,
  });

const WeightedStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.Weighted),
  chains: z.record(z.string(), WeightedChainConfigSchema),
});

const MinAmountStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.MinAmount),
  chains: z.record(z.string(), MinAmountChainConfigSchema),
});

const CollateralDeficitStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.CollateralDeficit),
  chains: z.record(z.string(), CollateralDeficitChainConfigSchema),
});

// Single strategy schema (non-composite)
const SingleStrategySchema = z.discriminatedUnion('rebalanceStrategy', [
  WeightedStrategySchema,
  MinAmountStrategySchema,
  CollateralDeficitStrategySchema,
]);

// Composite strategy schema - an array of single strategies
const CompositeStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.Composite),
  strategies: z.array(SingleStrategySchema).min(1),
});

export type WeightedStrategy = z.infer<typeof WeightedStrategySchema>;
export type MinAmountStrategy = z.infer<typeof MinAmountStrategySchema>;
export type CollateralDeficitStrategy = z.infer<
  typeof CollateralDeficitStrategySchema
>;
export type CompositeStrategy = z.infer<typeof CompositeStrategySchema>;

export type WeightedStrategyConfig = WeightedStrategy['chains'];
export type MinAmountStrategyConfig = MinAmountStrategy['chains'];
export type CollateralDeficitStrategyConfig =
  CollateralDeficitStrategy['chains'];

// Export individual strategy schemas for the composite
export {
  WeightedStrategySchema,
  MinAmountStrategySchema,
  CollateralDeficitStrategySchema,
  SingleStrategySchema,
  CompositeStrategySchema,
};

export const StrategyConfigSchema = z.discriminatedUnion('rebalanceStrategy', [
  WeightedStrategySchema,
  MinAmountStrategySchema,
  CollateralDeficitStrategySchema,
  CompositeStrategySchema,
]);

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: StrategyConfigSchema,
    /** Explorer GraphQL API URL for inflight message tracking */
    explorerUrl: z.string().url().optional(),
  })
  .superRefine((config, ctx) => {
    // Helper to validate a single strategy's chains
    const validateStrategyChains = (
      strategy: z.infer<typeof SingleStrategySchema>,
      pathPrefix: string[],
    ) => {
      const chainNames = new Set(Object.keys(strategy.chains));

      // Check each chain's overrides
      for (const [chainName, chainConfig] of Object.entries(strategy.chains)) {
        if (chainConfig.override) {
          for (const overrideChainName of Object.keys(chainConfig.override)) {
            // Each override key must reference a valid chain
            if (!chainNames.has(overrideChainName)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Chain '${chainName}' has an override for '${overrideChainName}', but '${overrideChainName}' is not defined in the config`,
                path: [
                  ...pathPrefix,
                  'chains',
                  chainName,
                  'override',
                  overrideChainName,
                ],
              });
            }

            // Override shouldn't be self-referencing
            if (chainName === overrideChainName) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Chain '${chainName}' has an override for '${chainName}', but '${chainName}' is self-referencing`,
                path: [
                  ...pathPrefix,
                  'chains',
                  chainName,
                  'override',
                  overrideChainName,
                ],
              });
            }
          }
        }
      }

      // Validate minAmount type consistency
      if (strategy.rebalanceStrategy === RebalancerStrategyOptions.MinAmount) {
        const minAmountChainsTypes = Object.values(strategy.chains).map(
          (c: any) => c.minAmount.type,
        );
        if (new Set(minAmountChainsTypes).size > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `All chains must use the same minAmount type.`,
            path: [...pathPrefix, 'chains'],
          });
        }
      }
    };

    // Handle composite vs single strategy
    if (
      config.strategy.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      const compositeStrategy = config.strategy as z.infer<
        typeof CompositeStrategySchema
      >;
      compositeStrategy.strategies.forEach((strategy, index) => {
        validateStrategyChains(strategy, [
          'strategy',
          'strategies',
          index.toString(),
        ]);
      });
    } else {
      validateStrategyChains(
        config.strategy as z.infer<typeof SingleStrategySchema>,
        ['strategy'],
      );
    }
  });

// Define separate types for each strategy config
export type RebalancerWeightedChainConfig = z.infer<
  typeof RebalancerWeightedChainConfigSchema
>;
export type RebalancerMinAmountChainConfig = z.infer<
  typeof RebalancerMinAmountConfigSchema
>;
export type RebalancerCollateralDeficitChainConfig = z.infer<
  typeof RebalancerCollateralDeficitChainConfigSchema
>;

export type SingleStrategyConfig = z.infer<typeof SingleStrategySchema>;

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export type RebalancerConfig = z.infer<typeof RebalancerConfigSchema>;
export type RebalancerConfigFileInput = z.input<typeof RebalancerConfigSchema>;
