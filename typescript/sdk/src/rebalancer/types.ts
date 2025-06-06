import { z } from 'zod';

import type { ChainMap } from '@hyperlane-xyz/sdk';

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
export const RebalancerBaseChainConfigSchema = z.object({
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
  weighted: RebalancerWeightedChainConfigSchema.optional(),
  minAmount: RebalancerMinAmountConfigSchema.optional(),
});

export const RebalancerChainConfigSchema =
  RebalancerBaseChainConfigSchema.extend({
    override: z
      .record(
        z.string(),
        RebalancerBaseChainConfigSchema.omit({
          weighted: true,
          minAmount: true,
        })
          .partial()
          .passthrough(),
      )
      .optional(),
  });

export const RebalancerBaseConfigSchema = z.object({
  warpRouteId: z.string(),
  rebalanceStrategy: z.nativeEnum(RebalancerStrategyOptions),
});

export const RebalancerConfigSchema = RebalancerBaseConfigSchema.catchall(
  RebalancerChainConfigSchema,
).superRefine((config, ctx) => {
  // Get all chain names from the config
  const chainNames = new Set(
    Object.keys(config).filter(
      (key) => !Object.keys(RebalancerBaseConfigSchema.shape).includes(key),
    ),
  );

  // Check each chain's overrides
  for (const chainName of chainNames) {
    const chain = config[chainName] as RebalancerChainConfig;

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

  const minAmountChainsTypes: RebalancerMinAmountType[] = [];
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
});

// Define separate types for each strategy config
export type RebalancerWeightedChainConfig = z.infer<
  typeof RebalancerWeightedChainConfigSchema
>;
export type RebalancerMinAmountChainConfig = z.infer<
  typeof RebalancerMinAmountConfigSchema
>;

// Union type for all chain configs
export type RebalancerChainConfig = z.infer<typeof RebalancerChainConfigSchema>;
export type RebalancerChainConfigInput = z.input<
  typeof RebalancerChainConfigSchema
>;

export type RebalancerBaseConfig = z.infer<typeof RebalancerBaseConfigSchema>;
export type RebalancerBaseConfigInput = z.input<
  typeof RebalancerBaseConfigSchema
>;

// TODO: Simplify this typing structure by modifying `BaseConfigSchema` to have a `chains` entry
//  `chains: z.record(z.string(), ChainConfigSchema),`
//  Thus we avoid having mixed "specific" vs "index signature", and migrate all to "specific".
//  An example of what the issue is can be found at: https://tsplay.dev/NljqOW
export type RebalancerConfigFileInput = RebalancerBaseConfigInput &
  ChainMap<
    | RebalancerChainConfigInput
    // to allow "specific" and "index signature" mix
    | any
  >;
