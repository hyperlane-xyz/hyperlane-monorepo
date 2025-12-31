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

// CollateralDeficit strategy config schema
export const RebalancerCollateralDeficitConfigSchema = z.object({
  bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
  buffer: z
    .string()
    .or(z.number())
    .describe('Buffer amount to add to deficit for headroom (in token units)'),
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

// CollateralDeficit extends base config but uses its own bridge in collateralDeficit.bridge
// The base bridge/bridgeLockTime are for the "normal" rebalancing path when used in CompositeStrategy
const CollateralDeficitChainConfigSchema =
  RebalancerBaseChainConfigSchema.extend({
    collateralDeficit: RebalancerCollateralDeficitConfigSchema,
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

export type WeightedStrategy = z.infer<typeof WeightedStrategySchema>;
export type MinAmountStrategy = z.infer<typeof MinAmountStrategySchema>;
export type CollateralDeficitStrategy = z.infer<
  typeof CollateralDeficitStrategySchema
>;

export type WeightedStrategyConfig = WeightedStrategy['chains'];
export type MinAmountStrategyConfig = MinAmountStrategy['chains'];
export type CollateralDeficitStrategyConfig =
  CollateralDeficitStrategy['chains'];

// SingleStrategyConfig is a discriminated union of non-composite strategies
export const SingleStrategyConfigSchema = z.discriminatedUnion(
  'rebalanceStrategy',
  [
    WeightedStrategySchema,
    MinAmountStrategySchema,
    CollateralDeficitStrategySchema,
  ],
);

export type SingleStrategyConfig = z.infer<typeof SingleStrategyConfigSchema>;

// CompositeStrategy chains multiple strategies together
const CompositeStrategySchema = z.object({
  rebalanceStrategy: z.literal(RebalancerStrategyOptions.Composite),
  strategies: z.array(SingleStrategyConfigSchema).min(1),
});

export type CompositeStrategy = z.infer<typeof CompositeStrategySchema>;

export const StrategyConfigSchema = z.discriminatedUnion('rebalanceStrategy', [
  WeightedStrategySchema,
  MinAmountStrategySchema,
  CollateralDeficitStrategySchema,
  CompositeStrategySchema,
]);

/**
 * Validate a single (non-composite) strategy's chains and overrides.
 */
function validateSingleStrategy(
  strategy: SingleStrategyConfig,
  ctx: z.RefinementCtx,
  pathPrefix: string[] = ['strategy'],
): void {
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

  // Validate MinAmount-specific constraints
  if (strategy.rebalanceStrategy === RebalancerStrategyOptions.MinAmount) {
    const minAmountChainsTypes = Object.values(strategy.chains).map(
      (c) => c.minAmount.type,
    );
    if (new Set(minAmountChainsTypes).size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `All chains must use the same minAmount type.`,
        path: [...pathPrefix, 'chains'],
      });
    }
  }
}

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: StrategyConfigSchema,
    /** Optional: Explorer URL for inflight message tracking (enables ActionTracker) */
    explorerUrl: z.string().url().optional(),
    /** Optional: Rebalancer wallet address (required when explorerUrl is set) */
    rebalancerAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  })
  .superRefine((config, ctx) => {
    // Validate explorerUrl requires rebalancerAddress
    if (config.explorerUrl && !config.rebalancerAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rebalancerAddress is required when explorerUrl is set`,
        path: ['rebalancerAddress'],
      });
    }

    if (
      config.strategy.rebalanceStrategy === RebalancerStrategyOptions.Composite
    ) {
      // Validate each sub-strategy in the composite
      for (let i = 0; i < config.strategy.strategies.length; i++) {
        validateSingleStrategy(config.strategy.strategies[i], ctx, [
          'strategy',
          'strategies',
          String(i),
        ]);
      }
    } else {
      // Validate the single strategy directly
      validateSingleStrategy(config.strategy, ctx);
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
  typeof RebalancerCollateralDeficitConfigSchema
>;

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export type RebalancerConfig = z.infer<typeof RebalancerConfigSchema>;
export type RebalancerConfigFileInput = z.input<typeof RebalancerConfigSchema>;

/**
 * Get all chain names from a strategy config.
 * For composite strategies, collects chains from all sub-strategies.
 */
export function getStrategyChainNames(strategy: StrategyConfig): string[] {
  if (strategy.rebalanceStrategy === RebalancerStrategyOptions.Composite) {
    const chainSet = new Set<string>();
    for (const subStrategy of strategy.strategies) {
      Object.keys(subStrategy.chains).forEach((chain) => chainSet.add(chain));
    }
    return Array.from(chainSet);
  }
  return Object.keys(strategy.chains);
}

/**
 * Get chain config from a strategy, supporting both single and composite strategies.
 * For composite strategies, returns the first matching chain config found.
 */
export function getStrategyChainConfig(
  strategy: StrategyConfig,
  chainName: string,
): SingleStrategyConfig['chains'][string] | undefined {
  if (strategy.rebalanceStrategy === RebalancerStrategyOptions.Composite) {
    for (const subStrategy of strategy.strategies) {
      if (chainName in subStrategy.chains) {
        return subStrategy.chains[chainName];
      }
    }
    return undefined;
  }
  return strategy.chains[chainName];
}
