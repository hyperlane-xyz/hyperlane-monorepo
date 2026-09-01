import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import {
  ZBigNumberish,
  ZChainName,
  ZHash,
} from '../metadata/customZodTypes.js';
import { ChainMap, OwnableSchema } from '../types.js';

import {
  WormholeConsistencyLevelFields,
  WormholeConsistencyLevelSchema,
  consistencyLevelForConfig,
} from './consistency.js';

export {
  WormholeConsistencyLevel,
  WormholeConsistencyLevelConfigSchema,
  WormholeConsistencyLevelSchema,
  WormholeConsistencyType,
  WormholeStandardConsistencyTypeSchema,
  consistencyLevelConfigFromOnchain,
  consistencyLevelForConfig,
  standardConsistencyType,
} from './consistency.js';
export type {
  WormholeConsistencyLevelConfig,
  WormholeStandardConsistencyType,
} from './consistency.js';

/**
 * Wormhole hook/ISM configuration.
 *
 * One combined router is deployed per chain and enrolls every other chain in
 * the mesh. The same local address is configured as an application's outbound
 * hook and inbound ISM, so hook and ISM views share this one config type and
 * cannot diverge.
 */

export const WormholeVariant = {
  /** Executor delivers the VAA to `executeVAAv1`; ISM metadata stays empty. */
  Executor: 'wormholeExecutor',
  /** Hyperlane carries the VAA as CCIP-read ISM metadata. */
  DirectVaa: 'wormholeVaa',
} as const;
export type WormholeVariant =
  (typeof WormholeVariant)[keyof typeof WormholeVariant];

export const WormholeRemoteRouterSchema = z.object({
  /** Enrolled remote router address on that chain. */
  router: ZHash,
  wormholeChainId: z.number().int().positive().max(65_535),
  expectedConsistencyLevel: WormholeConsistencyLevelSchema,
  /** Executor only: provider quoter key registered in the Quoter Router. */
  quoter: ZHash.optional(),
  /** Executor only: destination gas bought for `executeVAAv1`. */
  callbackGasLimit: ZBigNumberish.optional(),
});

export type WormholeRemoteRouterConfig = z.infer<
  typeof WormholeRemoteRouterSchema
>;

const BaseWormholeHookIsmSchema = OwnableSchema.extend({
  ...WormholeConsistencyLevelFields,
  type: z.union([
    z.literal(WormholeVariant.Executor),
    z.literal(WormholeVariant.DirectVaa),
  ]),
  mailbox: ZHash,
  /** Official Wormhole Core proxy for this chain. */
  core: ZHash,
  /** Optional deployment-time assertion against Core.chainId(). */
  wormholeChainId: z.number().int().positive().max(65_535).optional(),
  /** Executor only: the shared, Wormhole-published Quoter Router. */
  executorQuoterRouter: ZHash.optional(),
  /** Direct-VAA only: CCIP-read lookup service URLs. */
  urls: z.array(z.string().url()).min(1).optional(),
  remoteRouters: z.record(ZChainName, WormholeRemoteRouterSchema),
});

/**
 * Rejects configurations that mix the two variants' fields, and enforces that
 * an Executor route is never enrollable without its delivery configuration —
 * mirroring the on-chain atomicity of `enrollRemoteRouter`.
 */
export const WormholeHookIsmSchema = BaseWormholeHookIsmSchema.superRefine(
  (config, ctx) => {
    if (config.type === WormholeVariant.Executor) {
      if (!config.executorQuoterRouter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executorQuoterRouter'],
          message: 'wormholeExecutor requires executorQuoterRouter',
        });
      }
      if (config.urls) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['urls'],
          message: 'urls is a wormholeVaa field',
        });
      }
      for (const [chain, remote] of Object.entries(config.remoteRouters)) {
        if (!remote.quoter) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remoteRouters', chain, 'quoter'],
            message: 'wormholeExecutor requires a quoter for every route',
          });
        }
        if (
          remote.callbackGasLimit === undefined ||
          BigInt(remote.callbackGasLimit) === 0n
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remoteRouters', chain, 'callbackGasLimit'],
            message:
              'wormholeExecutor requires a nonzero callbackGasLimit for every route',
          });
        }
      }
    }

    if (config.type === WormholeVariant.DirectVaa) {
      if (!config.urls) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['urls'],
          message: 'wormholeVaa requires urls',
        });
      }
      if (config.executorQuoterRouter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executorQuoterRouter'],
          message: 'executorQuoterRouter is a wormholeExecutor field',
        });
      }
      for (const [chain, remote] of Object.entries(config.remoteRouters)) {
        if (remote.quoter || remote.callbackGasLimit !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['remoteRouters', chain],
            message: 'quoter and callbackGasLimit are wormholeExecutor fields',
          });
        }
      }
    }

    // A Wormhole chain ID identifies exactly one Hyperlane domain, matching the
    // on-chain reverse index that rejects aliases.
    const byWormholeChainId = new Map<number, string>();
    for (const [chain, remote] of Object.entries(config.remoteRouters)) {
      const existing = byWormholeChainId.get(remote.wormholeChainId);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['remoteRouters', chain, 'wormholeChainId'],
          message: `Wormhole chain ID ${remote.wormholeChainId} is already claimed by ${existing}`,
        });
      }
      byWormholeChainId.set(remote.wormholeChainId, chain);
    }
  },
);

export type WormholeHookIsmConfig = z.infer<typeof WormholeHookIsmSchema>;

/** A whole mesh, keyed by chain. */
export const WormholeMeshSchema = z.record(ZChainName, WormholeHookIsmSchema);

export type WormholeMeshConfig = ChainMap<WormholeHookIsmConfig>;

export type DerivedWormholeHookIsmConfig = Omit<
  WormholeHookIsmConfig,
  'wormholeChainId'
> & {
  address: Address;
  wormholeChainId: number;
};

export type WormholeHookIsmAddresses = {
  deployedRouter: Address;
  mailbox: Address;
};

/**
 * Checks that every chain in the mesh enrolls, and is enrolled by, every other
 * chain. A valid `A -> B` entry does not prove `B -> A`, and a one-sided mesh
 * silently strands one direction.
 */
export function findAsymmetricWormholeRoutes(
  mesh: WormholeMeshConfig,
): Array<string> {
  const problems: Array<string> = [];
  const chains = Object.keys(mesh);

  for (const origin of chains) {
    for (const destination of chains) {
      if (origin === destination) continue;

      const outbound = mesh[origin].remoteRouters[destination];
      if (!outbound) {
        problems.push(`${origin} does not enroll ${destination}`);
        continue;
      }

      const inbound = mesh[destination].remoteRouters[origin];
      if (!inbound) {
        problems.push(`${destination} does not enroll ${origin}`);
        continue;
      }

      const destinationConsistency = consistencyLevelForConfig(
        mesh[destination].consistencyLevel,
      );
      if (outbound.expectedConsistencyLevel !== destinationConsistency) {
        problems.push(
          `${origin} expects consistency ${outbound.expectedConsistencyLevel} from ${destination}, which publishes at ${destinationConsistency}`,
        );
      }

      if (mesh[origin].type !== mesh[destination].type) {
        problems.push(
          `${origin} is ${mesh[origin].type} but ${destination} is ${mesh[destination].type}`,
        );
      }
    }
  }

  return problems;
}
