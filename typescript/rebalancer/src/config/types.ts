import { z } from 'zod';

import type { ChainMap } from '@hyperlane-xyz/sdk';
import { ProtocolType, isAddressEvm } from '@hyperlane-xyz/utils';

const SEALEVEL_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
  DeBridge = 'debridge',
  LayerZero = 'layerzero',
  SwapsXyz = 'swapsxyz',
  Relay = 'relay',
}

/** Rules for physical inventory movements, independent of strategy route direction. */
export const InventoryRouteConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  externalBridge: z.enum(ExternalBridgeType).optional(),
  priority: z.number().int().nonnegative().optional(),
});

export const InventoryRoutesConfigSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), InventoryRouteConfigSchema),
);

export type InventoryRoutesConfig = ChainMap<
  ChainMap<z.infer<typeof InventoryRouteConfigSchema>>
>;

export function getInventoryRouteChainNames(
  routes: InventoryRoutesConfig | undefined,
): string[] {
  return Array.from(
    new Set(
      Object.entries(routes ?? {}).flatMap(([source, destinations]) => [
        source,
        ...Object.keys(destinations),
      ]),
    ),
  );
}

export enum TokenBridgeStatusAdapterType {
  HyperlaneMessage = 'hyperlane_message',
  LayerZeroScan = 'lz_scan',
}

export const TokenBridgeStatusAdapterConfigSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal(TokenBridgeStatusAdapterType.HyperlaneMessage),
    }),
    z.object({
      kind: z.literal(TokenBridgeStatusAdapterType.LayerZeroScan),
      sourceEid: z.number().int().positive().max(0xffffffff),
      destinationEid: z.number().int().positive().max(0xffffffff),
      sourceOft: z.string().refine(isAddressEvm, 'Invalid source OFT address'),
      destinationOft: z
        .string()
        .refine(isAddressEvm, 'Invalid destination OFT address'),
      // An explicit assertion of the monitored recipient, never a wildcard.
      destinationRecipient: z
        .string()
        .refine(isAddressEvm, 'Invalid destination recipient')
        .optional(),
    }),
  ],
);

export type TokenBridgeStatusAdapterConfig = z.infer<
  typeof TokenBridgeStatusAdapterConfigSchema
>;

export const RebalancerMinAmountConfigSchema = z.object({
  min: z.string().or(z.number()),
  target: z.string().or(z.number()),
  type: z.enum(RebalancerMinAmountType),
});

const RebalancerBridgeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  bridge: z
    .string()
    .regex(/0x[a-fA-F0-9]{40}/)
    .optional(),
  executionType: z.enum(ExecutionType).optional(),
  externalBridge: z.enum(ExternalBridgeType).optional(),
  statusAdapter: TokenBridgeStatusAdapterConfigSchema.optional(),
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
      .record(
        z.string(),
        z.strictObject(RebalancerBridgeConfigSchema.partial().shape),
      )
      .optional(),
  });

// Schemas for strategy-specific chain configs
const WeightedChainConfigSchema = RebalancerBaseChainConfigSchema.extend({
  weighted: RebalancerWeightedChainConfigSchema,
}).strict();

const MinAmountChainConfigSchema = RebalancerBaseChainConfigSchema.extend({
  minAmount: RebalancerMinAmountConfigSchema,
}).strict();

const CollateralDeficitChainConfigSchema =
  RebalancerBaseChainConfigSchema.extend({
    buffer: z.string().or(z.number()),
  }).strict();

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

export const DEFAULT_INTENT_TTL_S = 1_209_600; // 14 days
export const DEFAULT_INTENT_TTL_MS = DEFAULT_INTENT_TTL_S * 1_000;

export const DEFAULT_MOVEMENT_STALENESS_MS = 30 * 60 * 1_000; // 30 minutes

export const LiFiBridgeConfigSchema = z.object({
  integrator: z.string(),
  defaultSlippage: z.number().optional(),
});

export const DeBridgeBridgeConfigSchema = z.object({
  maxFeeBps: z.number().int().min(0).max(10_000).default(50),
  maxEvmNativeValueWei: z.coerce.bigint().nonnegative().optional(),
  maxTronNativeValueSun: z.coerce.bigint().nonnegative().optional(),
  maxSolanaNativeSpendLamports: z.coerce.bigint().nonnegative().optional(),
});

export const LayerZeroBridgeConfigSchema = z.object({
  warpRouteIds: z.array(z.string().min(1)).min(1),
  maxFeeBps: z.number().int().min(0).max(10_000).default(50),
  maxEvmNativeValueWei: z.coerce.bigint().nonnegative().optional(),
  maxTronNativeValueSun: z.coerce.bigint().nonnegative().optional(),
});

export const DEFAULT_MAX_SOLANA_TRANSACTION_FEE_LAMPORTS = 10_000_000;
export const DEFAULT_SOLANA_TRANSACTION_FEE_WARNING_LAMPORTS = 1_000_000;

export const SwapsXyzBridgeConfigSchema = z
  .object({
    apiUrl: z.string().url().startsWith('https://').optional(),
    defaultSlippage: z.number().positive().max(0.1).optional(),
    maxQuoteLossBps: z.number().int().min(0).max(10_000).default(50),
    maxEvmNativeFeeWei: z.coerce.bigint().nonnegative().optional(),
    maxTronNativeFeeSun: z.coerce.bigint().nonnegative().optional(),
    maxSolanaTransactionFeeLamports: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    solanaTransactionFeeWarningLamports: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxSolanaNativeSpendLamports: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .refine(
    (config) =>
      (config.solanaTransactionFeeWarningLamports ??
        DEFAULT_SOLANA_TRANSACTION_FEE_WARNING_LAMPORTS) <=
      (config.maxSolanaTransactionFeeLamports ??
        DEFAULT_MAX_SOLANA_TRANSACTION_FEE_LAMPORTS),
    {
      message: 'Solana transaction fee warning must not exceed its cap',
      path: ['solanaTransactionFeeWarningLamports'],
    },
  );

export const RelayBridgeConfigSchema = z.strictObject({
  apiUrl: z.string().url().startsWith('https://').optional(),
  defaultSlippage: z.number().min(0).max(0.1).default(0.001),
  maxQuoteLossBps: z.number().int().min(0).max(10_000).default(100),
});

export const ExternalBridgesConfigSchema = z.object({
  lifi: LiFiBridgeConfigSchema.optional(),
  debridge: DeBridgeBridgeConfigSchema.optional(),
  layerzero: LayerZeroBridgeConfigSchema.optional(),
  swapsxyz: SwapsXyzBridgeConfigSchema.optional(),
  relay: RelayBridgeConfigSchema.optional(),
});

export const PendingTransferMiddlewareType = {
  RelayerDenylist: 'relayerDenylist',
  BlacklistIsm: 'blacklistIsm',
} as const;

export type PendingTransferMiddlewareType =
  (typeof PendingTransferMiddlewareType)[keyof typeof PendingTransferMiddlewareType];

const DEFAULT_RELAYER_DENYLIST_REFRESH_INTERVAL_IN_SECONDS = 60;
const DEFAULT_BLACKLIST_ISM_REFRESH_INTERVAL_IN_SECONDS = 600;

const RELAYER_DENYLIST_URL_PROTOCOLS = ['https:', 'http:', 'file:'];

const RelayerDenylistMiddlewareConfigSchema = z
  .strictObject({
    type: z.literal(PendingTransferMiddlewareType.RelayerDenylist),
    url: z
      .string()
      .refine(
        (url) =>
          URL.canParse(url) &&
          RELAYER_DENYLIST_URL_PROTOCOLS.includes(new URL(url).protocol),
        'url must be an https://, http:// or file:// URL',
      )
      .refine(
        (url) =>
          !URL.canParse(url) ||
          (new URL(url).username === '' && new URL(url).password === ''),
        'url must not contain credentials',
      )
      .describe(
        'https://, http:// or file:// URL of the relayer denylist JSON.',
      ),
    refreshIntervalSecs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_RELAYER_DENYLIST_REFRESH_INTERVAL_IN_SECONDS)
      .describe('Seconds between denylist re-fetches.'),
  })
  .describe(
    'Ignores messages the relayer runtime denylist blocks. Startup retries a failed fetch twice and fails if every attempt fails or the file is invalid. Only messageId-only rules apply to rebalance messages: deny one only after its funds settled another way, since a denied rebalance stops counting as incoming collateral until its rule is removed or expires.',
  );

const BlacklistIsmMiddlewareConfigSchema = z
  .strictObject({
    type: z.literal(PendingTransferMiddlewareType.BlacklistIsm),
    refreshIntervalSecs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_BLACKLIST_ISM_REFRESH_INTERVAL_IN_SECONDS)
      .describe(
        'Minimum seconds between refreshes, which re-resolve the router ISMs and re-read their BlacklistIsm ids.',
      ),
  })
  .describe(
    'Ignores messages a BlacklistIsm in the destination router ISM rejects. Router ISMs are re-resolved on each refresh, and a destination whose refresh fails keeps its previous BlacklistIsms and ids; startup fails if no route pair has a BlacklistIsm that can block.',
  );

const PendingTransferMiddlewareConfigSchema = z.discriminatedUnion('type', [
  RelayerDenylistMiddlewareConfigSchema,
  BlacklistIsmMiddlewareConfigSchema,
]);

export type PendingTransferMiddlewareConfig = z.infer<
  typeof PendingTransferMiddlewareConfigSchema
>;

export const RebalancerConfigSchema = z
  .object({
    warpRouteId: z.string(),
    strategy: RebalancerStrategySchema,
    inventorySigners: z
      .partialRecord(
        z.enum(ProtocolType),
        z.union([
          z.object({ address: z.string(), key: z.string().optional() }),
          z.string().transform((address) => ({ address })),
        ]),
      )
      .optional(),
    externalBridges: ExternalBridgesConfigSchema.optional(),
    pendingTransferMiddlewares: z
      .array(PendingTransferMiddlewareConfigSchema)
      .optional()
      .describe(
        'Ordered middlewares applied to pending user transfers read from the Explorer; item 0 runs first on the raw result. Omit to disable.',
      ),
    inventoryRoutes: InventoryRoutesConfigSchema.optional(),
    intentTTL: z
      .number()
      .positive()
      .default(DEFAULT_INTENT_TTL_S)
      .describe(
        'Max age in seconds for uncommitted intents. Reserved source work never expires automatically. Default 14 days.',
      )
      .transform((val) => val * 1_000),
  })
  .strict()
  .transform((config, ctx) => {
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
            if (!SEALEVEL_ADDRESS_REGEX.test(signerConfig.address)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `inventorySigners.${protocol} must be a valid Solana base58 address (32-44 chars), got: ${signerConfig.address}`,
                path: ['inventorySigners', protocol],
              });
            }
          } else if (protocol === ProtocolType.Tron) {
            if (!isAddressEvm(signerConfig.address)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `inventorySigners.${protocol} must be a valid 0x hex address, got: ${signerConfig.address}`,
                path: ['inventorySigners', protocol],
              });
            }
          }
          // Other protocols: accept any non-empty string (future-proof)
        }
      }
    }

    const checkExternalBridge = (
      externalBridge: ExternalBridgeType | undefined,
      subject: string,
      path: (string | number)[],
    ) => {
      if (externalBridge === undefined) return;
      const isConfigured =
        config.externalBridges?.[externalBridge] !== undefined &&
        (externalBridge !== ExternalBridgeType.LiFi ||
          !!config.externalBridges?.lifi?.integrator);
      if (!isConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${subject} uses externalBridge: '${externalBridge}' but externalBridges.${externalBridge} is not configured`,
          path,
        });
      }
    };

    for (const [source, destinations] of Object.entries(
      config.inventoryRoutes ?? {},
    )) {
      for (const [destination, route] of Object.entries(destinations)) {
        if (source === destination) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Inventory movement source and destination must differ',
            path: ['inventoryRoutes', source, destination],
          });
        }
        checkExternalBridge(
          route.externalBridge,
          `Inventory route '${source}' to '${destination}'`,
          ['inventoryRoutes', source, destination, 'externalBridge'],
        );
      }
    }
    if (Object.keys(config.inventoryRoutes ?? {}).length > 0 && !hasInventory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inventoryRoutes requires an inventory execution strategy',
        path: ['inventoryRoutes'],
      });
    }

    for (
      let strategyIndex = 0;
      strategyIndex < config.strategy.length;
      strategyIndex++
    ) {
      const strategy = config.strategy[strategyIndex];
      for (const [chainName, chainConfig] of Object.entries(strategy.chains)) {
        checkExternalBridge(
          chainConfig.externalBridge,
          `Chain '${chainName}'`,
          ['strategy', strategyIndex, 'chains', chainName, 'externalBridge'],
        );

        if (chainConfig.override) {
          for (const [destination, overrideConfig] of Object.entries(
            chainConfig.override,
          )) {
            const parsedOverride =
              RebalancerBridgeConfigSchema.partial().parse(overrideConfig);
            checkExternalBridge(
              parsedOverride.externalBridge ?? chainConfig.externalBridge,
              `Chain '${chainName}'`,
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

    return config;
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
