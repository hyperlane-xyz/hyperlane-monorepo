import type { providers } from 'ethers';
import type { Logger } from 'pino';

import {
  IAggregationIsm__factory,
  IInterchainSecurityModule__factory,
  IRoutingIsm__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { ModuleType } from '@hyperlane-xyz/sdk';
import {
  bytes32ToAddress,
  eqAddress,
  parseMessage,
  redactErrorMessage,
} from '@hyperlane-xyz/utils';

import { RpcUnavailableError, readOnchain } from '../utils/rpcErrors.js';

/** The relayer's `ISM_MAX_DEPTH`: the root ISM is at depth 0. */
const CCIP_READ_ISM_MAX_DEPTH = 13;
/** The relayer's `ISM_MAX_COUNT`. */
const CCIP_READ_ISM_MAX_COUNT = 100;

/**
 * Runs an ISM read. A failure the chain answered (a revert, or no such
 * function) yields `undefined`; a failure no RPC provider answered propagates.
 */
async function readIsm<T>(
  read: () => Promise<T>,
  ism: string,
  log: Logger,
): Promise<T | undefined> {
  try {
    return await readOnchain(read);
  } catch (error: unknown) {
    if (error instanceof RpcUnavailableError) throw error;
    log.debug(
      { ism, error: redactErrorMessage(error) },
      'The chain did not answer an ISM read',
    );
    return undefined;
  }
}

/**
 * Whether `ism` is a CCIP-read ISM of the ISM tree that verifies `message` on
 * its destination: from the mailbox's recipient ISM, through routing ISMs'
 * routes and every module of aggregation ISMs. The walk stops at the first
 * match, so later branches are not read.
 *
 * The walk is level-order and reads each ISM once, so each is reached at its
 * smallest depth. Like the relayer, it does not read ISMs beyond its limits
 * (depth 13 and beyond, or after 100 ISMs). An ISM whose read no RPC provider
 * answered is skipped; if `ism` is not found, the first such failure is thrown
 * instead of answering `false`, since that ISM might have led to it.
 */
export async function treeContainsCcipReadIsm({
  provider,
  mailbox,
  message,
  ism: target,
  log,
}: {
  provider: providers.Provider;
  mailbox: string;
  message: string;
  ism: string;
  log: Logger;
}): Promise<boolean> {
  const recipient = bytes32ToAddress(parseMessage(message).recipient);
  const root = await readOnchain(() =>
    Mailbox__factory.connect(mailbox, provider).recipientIsm(recipient),
  );
  let unavailable: RpcUnavailableError | undefined;
  const notFound = () => {
    if (unavailable) throw unavailable;
    return false;
  };
  const visited = new Set<string>();
  let level = [root];
  for (
    let depth = 0;
    depth < CCIP_READ_ISM_MAX_DEPTH && level.length > 0;
    depth++
  ) {
    const next: string[] = [];
    for (const ism of level) {
      const key = ism.toLowerCase();
      if (visited.has(key)) continue;
      if (visited.size >= CCIP_READ_ISM_MAX_COUNT) return notFound();
      visited.add(key);
      try {
        const moduleType = await readIsm(
          () =>
            IInterchainSecurityModule__factory.connect(
              ism,
              provider,
            ).moduleType(),
          ism,
          log,
        );
        if (moduleType === ModuleType.CCIP_READ) {
          if (eqAddress(ism, target)) return true;
        } else if (moduleType === ModuleType.ROUTING) {
          const routed = await readIsm(
            () => IRoutingIsm__factory.connect(ism, provider).route(message),
            ism,
            log,
          );
          if (routed !== undefined) next.push(routed);
        } else if (moduleType === ModuleType.AGGREGATION) {
          const aggregation = await readIsm(
            () =>
              IAggregationIsm__factory.connect(
                ism,
                provider,
              ).modulesAndThreshold(message),
            ism,
            log,
          );
          if (aggregation !== undefined) next.push(...aggregation.modules);
        }
      } catch (error: unknown) {
        if (!(error instanceof RpcUnavailableError)) throw error;
        log.debug(
          { ism, error: redactErrorMessage(error) },
          'Could not read an ISM of the tree',
        );
        unavailable ??= error;
      }
    }
    level = next;
  }
  return notFound();
}
