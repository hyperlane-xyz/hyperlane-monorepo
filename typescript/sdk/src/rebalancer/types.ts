import { z } from 'zod';

export enum RebalancerStrategyOptions {
  Weighted = 'weighted',
  MinAmount = 'minAmount',
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

const WeightedStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.Weighted),
  chains: z.record(z.string(), WeightedChainConfigSchema),
});

const MinAmountStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.MinAmount),
  chains: z.record(z.string(), MinAmountChainConfigSchema),
});

export type WeightedStrategy = z.infer<typeof WeightedStrategySchema>;
export type MinAmountStrategy = z.infer<typeof MinAmountStrategySchema>;

export type WeightedStrategyConfig = WeightedStrategy['chains'];
export type MinAmountStrategyConfig = MinAmountStrategy['chains'];

export const StrategyConfigSchema = z.discriminatedUnion('rebalanceStrategy', [
  WeightedStrategySchema,
  MinAmountStrategySchema,
]);

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: StrategyConfigSchema,
  })
  .superRefine((config, ctx) => {
    const chainNames = new Set(Object.keys(config.strategy.chains));
    // Check each chain's overrides
    for (const [chainName, chainConfig] of Object.entries(
      config.strategy.chains,
    )) {
      if (chainConfig.override) {
        for (const overrideChainName of Object.keys(chainConfig.override)) {
          // Each override key must reference a valid chain
          if (!chainNames.has(overrideChainName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Chain '${chainName}' has an override for '${overrideChainName}', but '${overrideChainName}' is not defined in the config`,
              path: [
                'strategy',
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
                'strategy',
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

    if (
      config.strategy.rebalanceStrategy === RebalancerStrategyOptions.MinAmount
    ) {
      const minAmountChainsTypes = Object.values(config.strategy.chains).map(
        (c) => c.minAmount.type,
      );
      if (new Set(minAmountChainsTypes).size > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `All chains must use the same minAmount type.`,
          path: ['strategy', 'chains'],
        });
      }
    }
  });

// Define separate types for each strategy config
export type RebalancerWeightedChainConfig = z.infer<
  typeof RebalancerWeightedChainConfigSchema
>;
export type RebalancerMinAmountChainConfig = z.infer<
  typeof RebalancerMinAmountConfigSchema
>;

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export type RebalancerConfig = z.infer<typeof RebalancerConfigSchema>;
export type RebalancerConfigFileInput = z.input<typeof RebalancerConfigSchema>;
