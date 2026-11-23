import { z } from 'zod';

import { Address } from '@hyperlane-xyz/utils';

import { ZChainName, ZHash } from '../metadata/customZodTypes.js';
import { ChainMap, OwnableSchema } from '../types.js';

import {
  WormholeConsistencyLevelFields,
  WormholeVaaConsistencyLevelSchema,
  consistencyLevelConfigToOnchain,
} from './consistency.js';

export {
  WormholeConsistencyLevel,
  WormholeConsistencyLevelConfigSchema,
  WormholeConsistencyLevelSchema,
  WormholeConsistencyType,
  WormholeStandardConsistencyTypeSchema,
  WormholeVaaConsistencyLevel,
  WormholeVaaConsistencyLevelSchema,
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

export const WormholeRemoteRouterSchema = z.object({
  /** Enrolled remote router address on that chain. */
  router: ZHash,
  wormholeChainId: z.number().int().positive().max(65_535),
  expectedConsistencyLevel: WormholeVaaConsistencyLevelSchema,
  /** Custom base consistency level the remote router publishes with. */
  expectedCustomBaseConsistencyLevel: z.number().int().min(0).max(255),
  /** Additional blocks the remote router publishes with. */
  expectedAdditionalBlocks: z.number().int().min(0).max(65_535),
});

export type WormholeRemoteRouterConfig = z.infer<
  typeof WormholeRemoteRouterSchema
>;

const BaseWormholeHookIsmSchema = OwnableSchema.extend({
  ...WormholeConsistencyLevelFields,
  mailbox: ZHash,
  /** Official Wormhole Core proxy for this chain. */
  core: ZHash,
  /** Optional deployment-time assertion against Core.chainId(). */
  wormholeChainId: z.number().int().positive().max(65_535).optional(),
  /** CCIP-read lookup service URLs. */
  urls: z.array(z.string().url()).min(1),
  remoteRouters: z.record(ZChainName, WormholeRemoteRouterSchema),
});

export const WormholeHookIsmSchema = BaseWormholeHookIsmSchema.superRefine(
  (config, ctx) => {
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

      const destinationConsistency = consistencyLevelConfigToOnchain(
        mesh[destination].consistencyLevel,
      );
      if (
        outbound.expectedConsistencyLevel !==
        destinationConsistency.consistencyLevel
      ) {
        problems.push(
          `${origin} expects consistency ${outbound.expectedConsistencyLevel} from ${destination}, which publishes at ${destinationConsistency.consistencyLevel}`,
        );
      }

      if (
        outbound.expectedCustomBaseConsistencyLevel !==
          destinationConsistency.customBaseConsistencyLevel ||
        outbound.expectedAdditionalBlocks !==
          destinationConsistency.additionalBlocks
      ) {
        problems.push(
          `${origin} expects custom consistency ${outbound.expectedCustomBaseConsistencyLevel}+${outbound.expectedAdditionalBlocks} from ${destination}, which publishes at ${destinationConsistency.customBaseConsistencyLevel}+${destinationConsistency.additionalBlocks}`,
        );
      }
    }
  }

  return problems;
}
