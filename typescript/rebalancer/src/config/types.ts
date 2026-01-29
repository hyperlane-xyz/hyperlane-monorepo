import { z } from 'zod';

export enum RebalancerStrategyOptions {
  Weighted = 'weighted',
  MinAmount = 'minAmount',
  CollateralDeficit = 'collateralDeficit',
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

/**
 * Execution type for rebalancing on a chain:
 * - `movableCollateral`: Uses MovableCollateralRouter.rebalance() on-chain (requires bridge address)
 * - `inventory`: Uses external bridges (LiFi) + transferRemote (no bridge address needed)
 */
export enum ExecutionType {
  MovableCollateral = 'movableCollateral',
  Inventory = 'inventory',
}

export const RebalancerMinAmountConfigSchema = z.object({
  min: z.string().or(z.number()),
  target: z.string().or(z.number()),
  type: z.nativeEnum(RebalancerMinAmountType),
});

// Base chain config with common properties
const RebalancerBridgeConfigSchema = z.object({
  bridge: z
    .string()
    .regex(/0x[a-fA-F0-9]{40}/)
    .optional(), // Optional - required for movableCollateral, not needed for inventory
  executionType: z.nativeEnum(ExecutionType).optional(), // Defaults to movableCollateral
  bridgeMinAcceptedAmount: z.string().or(z.number()).optional(),
  bridgeLockTime: z
    .number()
    .positive()
    .transform((val) => val * 1_000)
    .optional()
    .describe('Expected time in seconds for bridge to process a transfer'),
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

const CollateralDeficitChainConfigSchema =
  RebalancerBaseChainConfigSchema.extend({
    buffer: z.string().or(z.number()),
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

export const StrategyConfigSchema = z.discriminatedUnion('rebalanceStrategy', [
  WeightedStrategySchema,
  MinAmountStrategySchema,
  CollateralDeficitStrategySchema,
]);

// Accept either a single strategy (backwards compatible) or an array of strategies
// Normalizes to array internally so the rest of the code doesn't need to change
export const RebalancerStrategySchema = z
  .union([
    StrategyConfigSchema, // Old format: single object
    z.array(StrategyConfigSchema).min(1), // New format: array
  ])
  .transform((val) => (Array.isArray(val) ? val : [val]));

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: RebalancerStrategySchema,
    // Global inventory config (optional - only needed when using inventory execution type)
    inventorySigner: z
      .string()
      .regex(/0x[a-fA-F0-9]{40}/)
      .optional()
      .describe(
        'EOA address for inventory operations (same key across all chains)',
      ),
    lifiIntegrator: z
      .string()
      .optional()
      .describe(
        'Integrator name for @lifi/sdk (required when using inventory execution)',
      ),
  })
  .superRefine((config, ctx) => {
    // CollateralDeficitStrategy must be first in composite if it is used
    if (config.strategy.length > 1) {
      const hasCollateralDeficit = config.strategy.some(
        (s) =>
          s.rebalanceStrategy === RebalancerStrategyOptions.CollateralDeficit,
      );
      const collateralDeficitFirst =
        config.strategy[0].rebalanceStrategy ===
        RebalancerStrategyOptions.CollateralDeficit;

      if (hasCollateralDeficit && !collateralDeficitFirst) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'CollateralDeficitStrategy must be first when used in composite strategy',
          path: ['strategy'],
        });
      }
    }

    // Validate each strategy in the array
    for (
      let strategyIndex = 0;
      strategyIndex < config.strategy.length;
      strategyIndex++
    ) {
      const strategy = config.strategy[strategyIndex];
      const chainNames = new Set(Object.keys(strategy.chains));

      // Check each chain's overrides
      for (const [chainName, chainConfig] of Object.entries(strategy.chains)) {
        if ('override' in chainConfig && chainConfig.override) {
          for (const overrideChainName of Object.keys(chainConfig.override)) {
            // Each override key must reference a valid chain
            if (!chainNames.has(overrideChainName)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Chain '${chainName}' has an override for '${overrideChainName}', but '${overrideChainName}' is not defined in the config`,
                path: [
                  'strategy',
                  strategyIndex,
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
                  strategyIndex,
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

      if (strategy.rebalanceStrategy === RebalancerStrategyOptions.MinAmount) {
        const minAmountChainsTypes = Object.values(strategy.chains).map(
          (c) => c.minAmount.type,
        );
        if (new Set(minAmountChainsTypes).size > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `All chains must use the same minAmount type.`,
            path: ['strategy', strategyIndex, 'chains'],
          });
        }
      }

      // Validate bridge requirement based on executionType
      for (const [chainName, chainConfig] of Object.entries(strategy.chains)) {
        const executionType =
          chainConfig.executionType ?? ExecutionType.MovableCollateral;

        // bridge is required for movableCollateral execution type
        if (
          executionType === ExecutionType.MovableCollateral &&
          !chainConfig.bridge
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Chain '${chainName}' uses movableCollateral execution but has no 'bridge' address`,
            path: ['strategy', strategyIndex, 'chains', chainName, 'bridge'],
          });
        }
      }
    }

    // Check if any chain uses inventory execution type
    const hasInventoryChains = config.strategy.some((strategy) =>
      Object.values(strategy.chains).some(
        (chainConfig) => chainConfig.executionType === ExecutionType.Inventory,
      ),
    );

    // Validate inventory config when inventory chains exist
    if (hasInventoryChains) {
      if (!config.inventorySigner) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'inventorySigner is required when any chain uses inventory execution type',
          path: ['inventorySigner'],
        });
      }
      if (!config.lifiIntegrator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'lifiIntegrator is required when any chain uses inventory execution type',
          path: ['lifiIntegrator'],
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
export type CollateralDeficitChainConfig = z.infer<
  typeof CollateralDeficitChainConfigSchema
>;

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export type RebalancerConfig = z.infer<typeof RebalancerConfigSchema>;
export type RebalancerConfigFileInput = z.input<typeof RebalancerConfigSchema>;

/**
 * Get all unique chain names from strategy config array.
 */
export function getStrategyChainNames(strategies: StrategyConfig[]): string[] {
  const chainSet = new Set<string>();
  for (const strategy of strategies) {
    Object.keys(strategy.chains).forEach((chain) => chainSet.add(chain));
  }
  return Array.from(chainSet);
}

/**
 * Get chain config from the first strategy that has it.
 * Returns undefined if no strategy has the chain.
 */
export function getStrategyChainConfig(
  strategies: StrategyConfig[],
  chainName: string,
): StrategyConfig['chains'][string] | undefined {
  for (const strategy of strategies) {
    if (chainName in strategy.chains) {
      return strategy.chains[chainName];
    }
  }
  return undefined;
}

/**
 * Get all unique bridge addresses from all strategies and their overrides.
 * This is used by ActionTracker to detect inflight rebalances across all configured bridges.
 */
export function getAllBridges(strategies: StrategyConfig[]): string[] {
  const bridges = new Set<string>();

  for (const strategy of strategies) {
    for (const chainConfig of Object.values(strategy.chains)) {
      if (chainConfig.bridge) {
        bridges.add(chainConfig.bridge);
      }

      if (chainConfig.override) {
        for (const overrideConfig of Object.values(chainConfig.override)) {
          const override = overrideConfig as { bridge?: string };
          if (override.bridge) {
            bridges.add(override.bridge);
          }
        }
      }
    }
  }

  return Array.from(bridges);
}

/**
 * Get the execution type for a chain.
 * Returns the executionType from chain config, or MovableCollateral as default.
 */
export function getChainExecutionType(
  strategies: StrategyConfig[],
  chainName: string,
): ExecutionType {
  const chainConfig = getStrategyChainConfig(strategies, chainName);
  return chainConfig?.executionType ?? ExecutionType.MovableCollateral;
}

/**
 * Check if any chain in the strategies uses inventory execution type.
 */
export function hasInventoryChains(strategies: StrategyConfig[]): boolean {
  return strategies.some((strategy) =>
    Object.values(strategy.chains).some(
      (chainConfig) => chainConfig.executionType === ExecutionType.Inventory,
    ),
  );
}
