import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

// Base chain config with common properties
const BaseChainConfigSchema = z.object({
  bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
  bridgeMinAcceptedAmount: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val))
    .optional(),
  bridgeLockTime: z
    .number()
    .positive()
    .describe('Expected time in milliseconds for bridge to process a transfer'),
  bridgeIsWarp: z
    .boolean()
    .optional()
    .describe('True if the bridge is another Warp Route'),
});

// Weighted strategy config schema
const WeightedChainConfigSchema = BaseChainConfigSchema.extend({
  weight: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
  tolerance: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
});

const MinAmountConfigSchema = BaseChainConfigSchema.extend({
  minAmount: z.string().or(z.number()),
  target: z.string().or(z.number()),
});

const OverrideValueSchema = BaseChainConfigSchema.partial().passthrough();

const BaseChainConfigSchemaWithOverride = BaseChainConfigSchema.extend({
  override: z.record(z.string(), OverrideValueSchema).optional(),
});

// Union of possible chain configs with override
export const ChainConfigSchema = z.union([
  BaseChainConfigSchemaWithOverride.merge(WeightedChainConfigSchema),
  BaseChainConfigSchemaWithOverride.merge(MinAmountConfigSchema),
]);

const BaseConfigSchema = z.object({
  warpRouteId: z.string().optional(),
  checkFrequency: z.number().optional(),
  withMetrics: z.boolean().optional().default(false),
  monitorOnly: z.boolean().optional().default(false),
  rebalanceStrategy: z.nativeEnum(StrategyOptions).optional(),
});

const ConfigSchema = BaseConfigSchema.catchall(ChainConfigSchema).superRefine(
  (config, ctx) => {
    // Get all chain names from the config
    const chainNames = new Set(
      Object.keys(config).filter(
        (key) => !Object.keys(BaseConfigSchema.shape).includes(key),
      ),
    );

    // Check each chain's overrides
    for (const chainName of chainNames) {
      const chain = config[chainName] as ChainConfig;

      if (chain.override) {
        for (const overrideChainName of Object.keys(chain.override)) {
          // Each override key must reference a valid chain
          if (!chainNames.has(overrideChainName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Chain '${chainName}' has an override for '${overrideChainName}', but '${overrideChainName}' is not defined in the config`,
              path: [chainName, 'override', overrideChainName],
            });
          }

          // Override shouldn't be self-referencing
          if (chainName === overrideChainName) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Chain '${chainName}' has an override for '${chainName}', but '${chainName}' is self-referencing`,
              path: [chainName, 'override', overrideChainName],
            });
          }
        }
      }
    }
  },
);

// Define separate types for each strategy config
export type WeightedChainConfig = z.infer<typeof WeightedChainConfigSchema>;

export type MinAmountChainConfig = z.infer<typeof MinAmountConfigSchema>;

// Union type for all chain configs
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export type BaseConfig = z.infer<typeof BaseConfigSchema>;

export class Config {
  constructor(
    public readonly rebalancerKey: string,
    public readonly warpRouteId: string,
    public readonly checkFrequency: number,
    public readonly monitorOnly: boolean,
    public readonly withMetrics: boolean,
    public readonly coingeckoApiKey: string,
    public readonly rebalanceStrategy: StrategyOptions,
    public readonly chains: ChainMap<ChainConfig>,
  ) {}

  static load(
    configFilePath: string,
    rebalancerKey: string,
    overrides: Partial<BaseConfig & { coingeckoApiKey: string }>,
  ) {
    const config = readYamlOrJson(configFilePath);
    const validationResult = ConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const {
      warpRouteId: fileWarpRouteId,
      checkFrequency: fileCheckFrequency,
      monitorOnly: fileMonitorOnly,
      withMetrics: fileWithMetrics,
      rebalanceStrategy: fileRebalanceStrategy,
      ...chains
    } = validationResult.data;

    if (!Object.keys(chains).length) {
      throw new Error('No chains configured');
    }

    const warpRouteId = overrides.warpRouteId ?? fileWarpRouteId;
    const checkFrequency = overrides.checkFrequency ?? fileCheckFrequency;
    const monitorOnly = overrides.monitorOnly ?? fileMonitorOnly;
    const withMetrics = overrides.withMetrics ?? fileWithMetrics;
    const coingeckoApiKey = overrides.coingeckoApiKey ?? '';
    const rebalanceStrategy =
      overrides.rebalanceStrategy ?? fileRebalanceStrategy;

    if (!warpRouteId) {
      throw new Error('warpRouteId is required');
    }

    if (!checkFrequency) {
      throw new Error('checkFrequency is required');
    }

    if (!rebalanceStrategy) {
      throw new Error('rebalanceStrategy is required');
    }

    return new Config(
      rebalancerKey,
      warpRouteId,
      checkFrequency,
      monitorOnly,
      withMetrics,
      coingeckoApiKey,
      rebalanceStrategy,
      chains,
    );
  }
}
