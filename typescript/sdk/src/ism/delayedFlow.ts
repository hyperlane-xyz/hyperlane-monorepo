import type { Logger } from 'pino';

import { DelayedFlowRouterHookIsm } from '@hyperlane-xyz/core';
import { concurrentMap, isNullish } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { DelayedFlowRouterHookIsmConfig } from './types.js';

export interface DelayedFlowEnrollment {
  chainName: ChainName;
  /** bytes32 counterpart address as stored on-chain, lowercased. */
  router: string;
}

export interface DelayedFlowEnrollments {
  /** Enrollments whose domain the MultiProvider can name. */
  named: DelayedFlowEnrollment[];
  /**
   * Enrolled domains the MultiProvider cannot name. A config can neither
   * express nor drop them, so callers comparing against a config must surface
   * them rather than ignore them.
   */
  unnamedDomains: number[];
}

/**
 * Reads a DelayedFlowRouterHookIsm's enrollment and resolves each enrolled
 * domain to a chain name.
 */
export async function readDelayedFlowEnrollments(
  ism: DelayedFlowRouterHookIsm,
  multiProvider: MultiProvider,
  concurrency: number,
  logger: Logger,
): Promise<DelayedFlowEnrollments> {
  const domainIds = await ism.domains();
  const resolved = domainIds.map((domainId) => ({
    domainId,
    chainName: multiProvider.tryGetChainName(domainId),
  }));

  const unnamedDomains = resolved
    .filter(({ chainName }) => isNullish(chainName))
    .map(({ domainId }) => domainId);
  if (unnamedDomains.length > 0) {
    logger.warn(
      `Unknown domain ID(s) ${unnamedDomains.join(', ')} enrolled on DelayedFlowRouterHookIsm at ${ism.address}; they cannot be named in a config`,
    );
  }

  const nameable = resolved.filter(
    (entry): entry is { domainId: number; chainName: ChainName } =>
      !isNullish(entry.chainName),
  );
  const named = await concurrentMap(
    concurrency,
    nameable,
    async ({ domainId, chainName }): Promise<DelayedFlowEnrollment> => ({
      chainName,
      router: (await ism.routers(domainId)).toLowerCase(),
    }),
  );

  return { named, unnamedDomains };
}

/**
 * Derives the chain-name-keyed remote ISM enrollment map shared by the hook
 * and ISM readers.
 */
export async function deriveDelayedFlowRemoteIsms(
  ism: DelayedFlowRouterHookIsm,
  multiProvider: MultiProvider,
  concurrency: number,
  logger: Logger,
): Promise<NonNullable<DelayedFlowRouterHookIsmConfig['remoteIsms']>> {
  const { named } = await readDelayedFlowEnrollments(
    ism,
    multiProvider,
    concurrency,
    logger,
  );
  return Object.fromEntries(
    named.map(({ chainName, router }) => [chainName, router]),
  );
}
