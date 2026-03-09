import { z } from 'zod';
import {
  ProtocolType,
  isAddressEvm,
  isValidAddressTron,
} from '@hyperlane-xyz/utils';

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

export enum ExternalBridgeType {
  LiFi = 'lifi',
  Meson = 'meson',
}

export const RebalancerMinAmountConfigSchema = z.object({
  min: z.string().or(z.number()),
  target: z.string().or(z.number()),
  type: z.nativeEnum(RebalancerMinAmountType),
});

const RebalancerBridgeConfigSchema = z.object({
  bridge: z
    .string()
    .regex(/0x[a-fA-F0-9]{40}/)
    .optional(),
  executionType: z.nativeEnum(ExecutionType).optional(),
  externalBridge: z.nativeEnum(ExternalBridgeType).optional(),
  bridgeMinAcceptedAmount: z.string().or(z.number()).optional(),
  bridgeLockTime: z
    .number()
    .positive()
    .transform((val) => val * 1_000)
    .optional(),
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

export const RebalancerStrategySchema = z
  .union([StrategyConfigSchema, z.array(StrategyConfigSchema).min(1)])
  .transform((val) => (Array.isArray(val) ? val : [val]));

export const DEFAULT_INTENT_TTL_S = 604800; // 7 days
export const DEFAULT_INTENT_TTL_MS = DEFAULT_INTENT_TTL_S * 1_000;

export const DEFAULT_MOVEMENT_STALENESS_MS = 30 * 60 * 1_000; // 30 minutes

export const LiFiBridgeConfigSchema = z.object({
  integrator: z.string(),
  defaultSlippage: z.number().optional(),
});

export const MesonBridgeConfigSchema = z.object({
  apiUrl: z.string().url().optional(),
  defaultSlippage: z.number().optional(),
});

export const ExternalBridgesConfigSchema = z.object({
  lifi: LiFiBridgeConfigSchema.optional(),
  meson: MesonBridgeConfigSchema.optional(),
});

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: RebalancerStrategySchema,
    inventorySigners: z
      .record(
        z.nativeEnum(ProtocolType),
        z.union([
          z.object({ address: z.string(), key: z.string().optional() }),
          z.string().transform((address) => ({ address })),
        ]),
      )
      .optional(),
    externalBridges: ExternalBridgesConfigSchema.optional(),
    intentTTL: z
      .number()
      .positive()
      .default(DEFAULT_INTENT_TTL_S)
      .describe(
        'Max age in seconds before in-progress intent is expired. Default 7 days.',
      )
      .transform((val) => val * 1_000),
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

        // externalBridge is required for inventory execution type
        if (
          executionType === ExecutionType.Inventory &&
          !chainConfig.externalBridge
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Chain '${chainName}' uses inventory execution but has no 'externalBridge' configured`,
            path: [
              'strategy',
              strategyIndex,
              'chains',
              chainName,
              'externalBridge',
            ],
          });
        }

        // Validate override content by merging override onto base config.
        if ('override' in chainConfig && chainConfig.override) {
          for (const [destination, destinationOverride] of Object.entries(
            chainConfig.override,
          )) {
            const mergedConfig = {
              ...chainConfig,
              ...(destinationOverride as Record<string, unknown>),
            };
            const mergedExecutionType =
              (mergedConfig.executionType as ExecutionType | undefined) ??
              ExecutionType.MovableCollateral;

            if (
              mergedExecutionType === ExecutionType.MovableCollateral &&
              !mergedConfig.bridge
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Chain '${chainName}' override for '${destination}' uses movableCollateral execution but has no 'bridge' address`,
                path: [
                  'strategy',
                  strategyIndex,
                  'chains',
                  chainName,
                  'override',
                  destination,
                  'bridge',
                ],
              });
            }

            if (
              mergedExecutionType === ExecutionType.Inventory &&
              !mergedConfig.externalBridge
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Chain '${chainName}' override for '${destination}' uses inventory execution but has no 'externalBridge' configured`,
                path: [
                  'strategy',
                  strategyIndex,
                  'chains',
                  chainName,
                  'override',
                  destination,
                  'externalBridge',
                ],
              });
            }
          }
        }
      }
    }

    const hasInventory = hasInventoryChains(config.strategy);

    if (hasInventory) {
      if (
        !config.inventorySigners ||
        !Object.keys(config.inventorySigners).length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'inventorySigners is required when any chain uses inventory execution type',
          path: ['inventorySigners'],
        });
      }

      // Validate address format per protocol
      if (config.inventorySigners) {
        for (const [protocol, signerConfig] of Object.entries(
          config.inventorySigners,
        )) {
          if (protocol === ProtocolType.Ethereum) {
            if (!isAddressEvm(signerConfig.address)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `inventorySigners.${protocol} must be a valid EVM address, got: ${signerConfig.address}`,
                path: ['inventorySigners', protocol],
              });
            }
          } else if (protocol === ProtocolType.Sealevel) {
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signerConfig.address)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `inventorySigners.${protocol} must be a valid Solana base58 address (32-44 chars), got: ${signerConfig.address}`,
                path: ['inventorySigners', protocol],
              });
            }
          } else if (protocol === ProtocolType.Tron) {
            if (!isValidAddressTron(signerConfig.address)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `inventorySigners.${protocol} must be a valid Tron address (T-prefix base58 or 0x hex), got: ${signerConfig.address}`,
                path: ['inventorySigners', protocol],
              });
            }
          }
          // Other protocols: accept any non-empty string (future-proof)
        }
      }

      // Collect all bridge types used across strategies
      const usedBridgeTypes = new Set<ExternalBridgeType>();
      for (const strategy of config.strategy) {
        for (const [, chainConfig] of Object.entries(strategy.chains)) {
          if (chainConfig.externalBridge) {
            usedBridgeTypes.add(chainConfig.externalBridge);
          }
          if (chainConfig.override) {
            for (const overrideConfig of Object.values(chainConfig.override)) {
              const merged = {
                ...chainConfig,
                ...(overrideConfig as Record<string, unknown>),
              };
              if ((merged as any).externalBridge) {
                usedBridgeTypes.add(
                  (merged as any).externalBridge as ExternalBridgeType,
                );
              }
            }
          }
        }
      }
      if (
        usedBridgeTypes.has(ExternalBridgeType.LiFi) &&
        !config.externalBridges?.lifi?.integrator
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'externalBridges.lifi is required when any chain uses externalBridge: lifi',
          path: ['externalBridges', 'lifi'],
        });
      }
      if (
        usedBridgeTypes.has(ExternalBridgeType.Meson) &&
        !config.externalBridges?.meson
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'externalBridges.meson is required when any chain uses externalBridge: meson',
          path: ['externalBridges', 'meson'],
        });
      }
    }

    for (
      let strategyIndex = 0;
      strategyIndex < config.strategy.length;
      strategyIndex++
    ) {
      const strategy = config.strategy[strategyIndex];
      for (const [chainName, chainConfig] of Object.entries(strategy.chains)) {
        const checkLifiBridge = (
          externalBridge: ExternalBridgeType | undefined,
          path: (string | number)[],
        ) => {
          if (
            externalBridge === ExternalBridgeType.LiFi &&
            !config.externalBridges?.lifi?.integrator
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Chain '${chainName}' uses externalBridge: 'lifi' but externalBridges.lifi is not configured`,
              path,
            });
          }
        };

        checkLifiBridge(chainConfig.externalBridge, [
          'externalBridges',
          'lifi',
        ]);

        if (chainConfig.override) {
          for (const [destination, overrideConfig] of Object.entries(
            chainConfig.override,
          )) {
            const merged = {
              ...chainConfig,
              ...(overrideConfig as Record<string, unknown>),
            };
            checkLifiBridge(
              merged.externalBridge as ExternalBridgeType | undefined,
              [
                'strategy',
                strategyIndex,
                'chains',
                chainName,
                'override',
                destination,
                'externalBridge',
              ],
            );
          }
        }
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
 * Extract the executionType from an override config object.
 * Returns undefined if the override config doesn't have an executionType field.
 */
export function getOverrideExecutionType(
  overrideConfig: unknown,
): ExecutionType | undefined {
  return typeof overrideConfig === 'object' &&
    overrideConfig !== null &&
    'executionType' in overrideConfig
    ? (overrideConfig as { executionType?: ExecutionType }).executionType
    : undefined;
}

/**
 * Get the names of all chains that use inventory execution type.
 * Includes both top-level inventory chains and override destination chains
 * where the override sets executionType to inventory.
 */
export function getInventoryChainNames(strategies: StrategyConfig[]): string[] {
  return Array.from(
    new Set(
      strategies.flatMap((strategy) => {
        const chainEntries = Object.entries(strategy.chains);
        const topLevelInventoryChains = chainEntries
          .filter(
            ([, chainConfig]) =>
              chainConfig.executionType === ExecutionType.Inventory,
          )
          .map(([chainName]) => chainName);

        const overrideInventoryChains = chainEntries.flatMap(
          ([, chainConfig]) => {
            if (!chainConfig.override) {
              return [];
            }

            const overrideEntries = Object.entries(chainConfig.override);

            return overrideEntries
              .filter(([, overrideConfig]) => {
                const overrideExecutionType =
                  getOverrideExecutionType(overrideConfig);

                return (
                  (overrideExecutionType ??
                    chainConfig.executionType ??
                    ExecutionType.MovableCollateral) === ExecutionType.Inventory
                );
              })
              .map(([destinationChain]) => destinationChain);
          },
        );

        return [...topLevelInventoryChains, ...overrideInventoryChains];
      }),
    ),
  );
}

export function getInventoryOriginChainNames(
  strategies: StrategyConfig[],
): string[] {
  return Array.from(
    new Set(
      strategies.flatMap((strategy) => {
        return Object.entries(strategy.chains).flatMap(
          ([originChainName, chainConfig]) => {
            if (!chainConfig.override) {
              return [];
            }

            const hasInventoryOverride = Object.values(
              chainConfig.override,
            ).some((overrideConfig) => {
              const overrideExecutionType =
                getOverrideExecutionType(overrideConfig);

              return (
                (overrideExecutionType ??
                  chainConfig.executionType ??
                  ExecutionType.MovableCollateral) === ExecutionType.Inventory
              );
            });

            return hasInventoryOverride ? [originChainName] : [];
          },
        );
      }),
    ),
  );
}

/**
 * Check if any chain in the strategies uses inventory execution type.
 */
export function hasInventoryChains(strategies: StrategyConfig[]): boolean {
  return getInventoryChainNames(strategies).length > 0;
}
