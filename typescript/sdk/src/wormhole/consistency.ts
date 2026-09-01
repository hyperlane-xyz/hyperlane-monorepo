import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';

/** Wormhole EVM watcher wire values; kept internal to config encoding. */
export const WormholeConsistencyLevel = {
  Instant: 200,
  Safe: 201,
  Finalized: 202,
  Custom: 203,
} as const;
export type WormholeConsistencyLevel =
  (typeof WormholeConsistencyLevel)[keyof typeof WormholeConsistencyLevel];
export const WormholeConsistencyLevelSchema = z.union([
  z.literal(WormholeConsistencyLevel.Instant),
  z.literal(WormholeConsistencyLevel.Safe),
  z.literal(WormholeConsistencyLevel.Finalized),
  z.literal(WormholeConsistencyLevel.Custom),
]);

export const WormholeConsistencyType = {
  Instant: 'instant',
  Safe: 'safe',
  Finalized: 'finalized',
  Custom: 'custom',
} as const;
export type WormholeConsistencyType =
  (typeof WormholeConsistencyType)[keyof typeof WormholeConsistencyType];

export const WormholeStandardConsistencyTypeSchema = z.union([
  z.literal(WormholeConsistencyType.Instant),
  z.literal(WormholeConsistencyType.Safe),
  z.literal(WormholeConsistencyType.Finalized),
]);

export type WormholeStandardConsistencyType = z.infer<
  typeof WormholeStandardConsistencyTypeSchema
>;

/**
 * User-facing consistency-level configuration. The discriminant makes custom level 203
 * impossible to represent without its CCL registration inputs.
 */
export const WormholeConsistencyLevelConfigSchema = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal(WormholeConsistencyType.Instant) }),
    z.object({ type: z.literal(WormholeConsistencyType.Safe) }),
    z.object({ type: z.literal(WormholeConsistencyType.Finalized) }),
    z.object({
      type: z.literal(WormholeConsistencyType.Custom),
      /** Official Wormhole Custom Consistency Level contract on this chain. */
      address: ZHash,
      /** Standard EVM level reached before counting `additionalBlocks`. */
      baseConsistencyLevel: WormholeStandardConsistencyTypeSchema,
      additionalBlocks: z.number().int().min(0).max(65_535),
    }),
  ],
);

export type WormholeConsistencyLevelConfig = z.infer<
  typeof WormholeConsistencyLevelConfigSchema
>;

export const WormholeConsistencyLevelFields = {
  consistencyLevel: WormholeConsistencyLevelConfigSchema,
};

export function consistencyLevelForConfig(
  config: WormholeConsistencyLevelConfig,
): WormholeConsistencyLevel {
  switch (config.type) {
    case WormholeConsistencyType.Instant:
      return WormholeConsistencyLevel.Instant;
    case WormholeConsistencyType.Safe:
      return WormholeConsistencyLevel.Safe;
    case WormholeConsistencyType.Finalized:
      return WormholeConsistencyLevel.Finalized;
    case WormholeConsistencyType.Custom:
      return WormholeConsistencyLevel.Custom;
  }
}

export function standardConsistencyType(
  consistencyLevel: number,
): WormholeStandardConsistencyType {
  switch (consistencyLevel) {
    case WormholeConsistencyLevel.Instant:
      return WormholeConsistencyType.Instant;
    case WormholeConsistencyLevel.Safe:
      return WormholeConsistencyType.Safe;
    case WormholeConsistencyLevel.Finalized:
      return WormholeConsistencyType.Finalized;
    default:
      throw new Error(
        `Unsupported standard Wormhole consistency level ${consistencyLevel}`,
      );
  }
}

export function consistencyLevelConfigFromOnchain(
  consistencyLevel: number,
  custom?: {
    address: string;
    baseConsistencyLevel: number;
    additionalBlocks: number;
  },
): WormholeConsistencyLevelConfig {
  if (consistencyLevel !== WormholeConsistencyLevel.Custom) {
    return { type: standardConsistencyType(consistencyLevel) };
  }
  if (!custom) {
    throw new Error('Custom Wormhole consistency level has no CCL config');
  }
  return {
    type: WormholeConsistencyType.Custom,
    address: custom.address,
    baseConsistencyLevel: standardConsistencyType(custom.baseConsistencyLevel),
    additionalBlocks: custom.additionalBlocks,
  };
}
