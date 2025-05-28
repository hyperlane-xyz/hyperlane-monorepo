import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';
import { StrategyOptions } from '../interfaces/IStrategy.js';

// Weighted strategy config schema
const WeightedChainConfigSchema = z.object({
  weight: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
  tolerance: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
});

export enum MinAmountType {
  Absolute = 'absolute',
  Relative = 'relative',
}

const MinAmountConfigSchema = z.object({
  min: z.string().or(z.number()),
  target: z.string().or(z.number()),
  type: z.nativeEnum(MinAmountType),
});

// Base chain config with common properties
const BaseChainConfigSchema = z.object({
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
  weighted: WeightedChainConfigSchema.optional(),
  minAmount: MinAmountConfigSchema.optional(),
});

const ChainConfigSchema = BaseChainConfigSchema.extend({
  override: z
    .record(
      z.string(),
      BaseChainConfigSchema.omit({
        weighted: true,
        minAmount: true,
      })
        .partial()
        .passthrough(),
    )
    .optional(),
});

const BaseConfigSchema = z.object({
  warpRouteId: z.string(),
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

    const minAmountChainsTypes: MinAmountType[] = [];
    for (const chainName of chainNames) {
      const chain = config[chainName];

      if (chain.minAmount) {
        minAmountChainsTypes.push(chain.minAmount.type);
      }
    }

    if (minAmountChainsTypes.length && new Set(minAmountChainsTypes).size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `All chains must use the same minAmount type.`,
        path: ['minAmount', 'type'],
      });
    }
  },
);

// Define separate types for each strategy config
export type WeightedChainConfig = z.infer<typeof WeightedChainConfigSchema>;
export type MinAmountChainConfig = z.infer<typeof MinAmountConfigSchema>;

// Union type for all chain configs
export type ChainConfig = z.infer<typeof ChainConfigSchema>;
export type ChainConfigInput = z.input<typeof ChainConfigSchema>;

export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export type BaseConfigInput = z.input<typeof BaseConfigSchema>;

// TODO: Simplify this typing structure by modifying `BaseConfigSchema` to have a `chains` entry
//  `chains: z.record(z.string(), ChainConfigSchema),`
//  Thus we avoid having mixed "specific" vs "index signature", and migrate all to "specific".
//  An example of what the issue is can be found at: https://tsplay.dev/NljqOW
export type ConfigFileInput = BaseConfigInput &
  ChainMap<
    | ChainConfigInput
    // to allow "specific" and "index signature" mix
    | any
  >;

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
    overrides: Partial<
      Omit<BaseConfig, 'warpRouteId'> & { coingeckoApiKey: string }
    >,
  ) {
    const config: ConfigFileInput = readYamlOrJson(configFilePath);
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

    const checkFrequency = overrides.checkFrequency ?? fileCheckFrequency;
    const monitorOnly = overrides.monitorOnly ?? fileMonitorOnly;
    const withMetrics = overrides.withMetrics ?? fileWithMetrics;
    const coingeckoApiKey = overrides.coingeckoApiKey ?? '';
    const rebalanceStrategy =
      overrides.rebalanceStrategy ?? fileRebalanceStrategy;

    if (!checkFrequency) {
      throw new Error('checkFrequency is required');
    }

    if (!rebalanceStrategy) {
      throw new Error('rebalanceStrategy is required');
    }

    return new Config(
      rebalancerKey,
      fileWarpRouteId,
      checkFrequency,
      monitorOnly,
      withMetrics,
      coingeckoApiKey,
      rebalanceStrategy,
      chains,
    );
  }
}
