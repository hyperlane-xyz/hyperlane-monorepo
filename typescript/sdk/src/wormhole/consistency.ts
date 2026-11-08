import { constants } from 'ethers';
import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';

/** Wormhole EVM watcher wire values; kept internal to config encoding. */
export const WormholeConsistencyLevel = {
  /** Documented finalized value; distinct on the wire from `Finalized`. */
  ZeroFinalized: 0,
  Instant: 200,
  Safe: 201,
  /** Guardian sentinel for the finalized block. */
  Finalized: 202,
  Custom: 203,
} as const;
export type WormholeConsistencyLevel =
  (typeof WormholeConsistencyLevel)[keyof typeof WormholeConsistencyLevel];
export const WormholeConsistencyLevelSchema = z.union([
  z.literal(WormholeConsistencyLevel.ZeroFinalized),
  z.literal(WormholeConsistencyLevel.Instant),
  z.literal(WormholeConsistencyLevel.Safe),
  z.literal(WormholeConsistencyLevel.Finalized),
  z.literal(WormholeConsistencyLevel.Custom),
]);

export const WormholeConsistencyType = {
  ZeroFinalized: 'zeroFinalized',
  Instant: 'instant',
  Safe: 'safe',
  Finalized: 'finalized',
  Custom: 'custom',
} as const;
export type WormholeConsistencyType =
  (typeof WormholeConsistencyType)[keyof typeof WormholeConsistencyType];

/**
 * Consistency levels a VAA from an enrolled remote router may carry: every EVM
 * publication level plus the Solana VAA values.
 */
export const WormholeVaaConsistencyLevel = {
  ZeroFinalized: WormholeConsistencyLevel.ZeroFinalized,
  Instant: WormholeConsistencyLevel.Instant,
  Safe: WormholeConsistencyLevel.Safe,
  Finalized: WormholeConsistencyLevel.Finalized,
  Custom: WormholeConsistencyLevel.Custom,
  SolanaVaaConfirmed: 1,
  SolanaVaaFinalized: 32,
} as const;

export type WormholeVaaConsistencyLevel =
  (typeof WormholeVaaConsistencyLevel)[keyof typeof WormholeVaaConsistencyLevel];

export const WormholeVaaConsistencyLevelSchema = z.union([
  z.literal(WormholeVaaConsistencyLevel.ZeroFinalized),
  z.literal(WormholeVaaConsistencyLevel.Instant),
  z.literal(WormholeVaaConsistencyLevel.Safe),
  z.literal(WormholeVaaConsistencyLevel.Finalized),
  z.literal(WormholeVaaConsistencyLevel.Custom),
  z.literal(WormholeVaaConsistencyLevel.SolanaVaaConfirmed),
  z.literal(WormholeVaaConsistencyLevel.SolanaVaaFinalized),
]);

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
    z.object({ type: z.literal(WormholeConsistencyType.ZeroFinalized) }),
    z.object({ type: z.literal(WormholeConsistencyType.Instant) }),
    z.object({ type: z.literal(WormholeConsistencyType.Safe) }),
    z.object({ type: z.literal(WormholeConsistencyType.Finalized) }),
    z.object({
      type: z.literal(WormholeConsistencyType.Custom),
      /** Official Wormhole Custom Consistency Level contract on this chain. */
      address: ZHash,
      /** Standard EVM level reached before counting `additionalBlocks`. */
      baseConsistencyLevel: WormholeStandardConsistencyTypeSchema,
      additionalBlocks: z.number().int().min(1).max(65_535),
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
    case WormholeConsistencyType.ZeroFinalized:
      return WormholeConsistencyLevel.ZeroFinalized;
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

export function consistencyLevelConfigToOnchain(
  config: WormholeConsistencyLevelConfig,
): {
  consistencyLevel: WormholeConsistencyLevel;
  customConsistencyLevelContract: string;
  customBaseConsistencyLevel: number;
  additionalBlocks: number;
} {
  if (config.type !== WormholeConsistencyType.Custom) {
    return {
      consistencyLevel: consistencyLevelForConfig(config),
      customConsistencyLevelContract: constants.AddressZero,
      customBaseConsistencyLevel: 0,
      additionalBlocks: 0,
    };
  }
  return {
    consistencyLevel: WormholeConsistencyLevel.Custom,
    customConsistencyLevelContract: config.address,
    customBaseConsistencyLevel: consistencyLevelForConfig({
      type: config.baseConsistencyLevel,
    }),
    additionalBlocks: config.additionalBlocks,
  };
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
  if (consistencyLevel === WormholeConsistencyLevel.ZeroFinalized) {
    return { type: WormholeConsistencyType.ZeroFinalized };
  }
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
