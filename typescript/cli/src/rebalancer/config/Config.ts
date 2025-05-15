import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import type { ChainMap } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

// Base chain config with common properties
const BaseChainConfigSchema = z.object({
  bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
  bridgeMinAcceptedAmount: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val))
    .optional(),
  bridgeTolerance: z
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

// Min amount strategy config schema
const MinAmountChainConfigSchema = BaseChainConfigSchema.extend({
  minAmount: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val)),
  buffer: z
    .string()
    .or(z.number())
    .transform((val) => BigInt(val))
    .default('0')
    .optional(),
});

const OverrideValueSchema = BaseChainConfigSchema.partial().passthrough();

const BaseChainConfigSchemaWithOverride = BaseChainConfigSchema.extend({
  override: z.record(z.string(), OverrideValueSchema).optional(),
});

const WeightedChainConfigSchemaWithOverride =
  BaseChainConfigSchemaWithOverride.merge(WeightedChainConfigSchema);

const MinAmountChainConfigSchemaWithOverride =
  BaseChainConfigSchemaWithOverride.merge(MinAmountChainConfigSchema);

// Union of possible chain configs with override
export const ChainConfigSchema = z.union([
  WeightedChainConfigSchemaWithOverride,
  MinAmountChainConfigSchemaWithOverride,
]);

const BaseConfigSchema = z.object({
  warpRouteId: z.string().optional(),
  checkFrequency: z.number().optional(),
  withMetrics: z.boolean().optional(),
  monitorOnly: z.boolean().optional(),
  coingeckoApiKey: z.string().optional(),
  rebalanceStrategy: z.enum(['weighted', 'minAmount']).optional(),
});

const ConfigSchema = BaseConfigSchema.catchall(ChainConfigSchema);

// Define separate types for each strategy config
export type WeightedChainConfig = z.infer<typeof WeightedChainConfigSchema>;
export type MinAmountChainConfig = z.infer<typeof MinAmountChainConfigSchema>;

// Union type for all chain configs
export type ChainConfig = z.infer<typeof ChainConfigSchema>;

export type BaseConfig = z.infer<typeof BaseConfigSchema>;

export class Config {
  static load(
    configFilePath: string,
    rebalancerKey: string,
    overrides: BaseConfig,
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
      coingeckoApiKey: fileWithCoingeckoApiKey,
      rebalanceStrategy: fileRebalanceStrategy,
      ...chains
    } = validationResult.data;

    if (!Object.keys(chains).length) {
      throw new Error('No chains configured');
    }

    const warpRouteId = overrides.warpRouteId ?? fileWarpRouteId;
    const checkFrequency = overrides.checkFrequency ?? fileCheckFrequency;
    const monitorOnly = overrides.monitorOnly ?? fileMonitorOnly ?? false;
    const withMetrics = overrides.withMetrics ?? fileWithMetrics ?? false;
    const coingeckoApiKey =
      overrides.coingeckoApiKey ?? fileWithCoingeckoApiKey ?? '';
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

  constructor(
    public readonly rebalancerKey: string,
    public readonly warpRouteId: string,
    public readonly checkFrequency: number,
    public readonly monitorOnly: boolean,
    public readonly withMetrics: boolean,
    public readonly coingeckoApiKey: string,
    public readonly rebalanceStrategy: 'weighted' | 'minAmount',
    public readonly chains: ChainMap<ChainConfig>,
  ) {}
}
