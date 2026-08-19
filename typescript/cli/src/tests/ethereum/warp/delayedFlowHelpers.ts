import { expect } from 'chai';
import type { providers } from 'ethers';

import {
  type DelayedFlowRouterHookIsm,
  DelayedFlowRouterHookIsm__factory,
  Mailbox__factory,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import { type Address, assert, pollAsync } from '@hyperlane-xyz/utils';

const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 45;

/**
 * Connects to the DelayedFlowRouterHookIsm instance a warp deploy wired as the
 * router's hook.
 */
export async function connectDelayedFlowIsm(
  provider: providers.Provider,
  tokenAddress: Address,
): Promise<DelayedFlowRouterHookIsm> {
  const hookAddress = await MailboxClient__factory.connect(
    tokenAddress,
    provider,
  ).hook();
  return DelayedFlowRouterHookIsm__factory.connect(hookAddress, provider);
}

/** How many transfers the instance has preverified so far. */
export async function countQueuedMessages(
  dfr: DelayedFlowRouterHookIsm,
): Promise<number> {
  return (await dfr.queryFilter(dfr.filters.MessageQueued())).length;
}

/**
 * Waits for the destination instance to preverify one more transfer than
 * `seenBefore` and returns that message id. Queueing is asynchronous: it only
 * happens once the relayer has delivered the DFR-to-DFR preverification
 * message.
 */
export async function waitForQueuedMessage(
  dfr: DelayedFlowRouterHookIsm,
  seenBefore: number,
): Promise<string> {
  return pollAsync(
    async () => {
      const queued = await dfr.queryFilter(dfr.filters.MessageQueued());
      assert(
        queued.length > seenBefore,
        `DelayedFlowRouterHookIsm ${dfr.address} has not queued a new message`,
      );
      const latest = queued[queued.length - 1];
      expect(latest.args.readyAt).to.be.greaterThan(0);
      expect((await dfr.readyAt(latest.args.messageId)).toString()).to.equal(
        latest.args.readyAt.toString(),
      );
      return latest.args.messageId;
    },
    POLL_INTERVAL_MS,
    POLL_ATTEMPTS,
  );
}

/**
 * Waits until the destination mailbox reports the transfer delivered. Queueing
 * only proves the message was preverified; delivery is what the delay gates,
 * and `warp send` without `--relay` returns at dispatch.
 */
export async function expectMessageDelivered(
  provider: providers.Provider,
  mailboxAddress: Address,
  messageId: string,
): Promise<void> {
  const mailbox = Mailbox__factory.connect(mailboxAddress, provider);
  await pollAsync(
    async () => {
      assert(
        await mailbox.delivered(messageId),
        `Message ${messageId} was not delivered to mailbox ${mailboxAddress}`,
      );
    },
    POLL_INTERVAL_MS,
    POLL_ATTEMPTS,
  );
}
