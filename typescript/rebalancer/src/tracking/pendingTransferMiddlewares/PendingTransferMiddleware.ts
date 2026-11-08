import type { Logger } from 'pino';

import { parseWarpRouteMessage } from '@hyperlane-xyz/utils';

import {
  DEFAULT_INFLIGHT_USER_TRANSFER_LIMIT,
  type ExplorerMessage,
  type IExplorerClient,
  type RebalanceActionQueryParams,
  type UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';

import { normalizeMessageId } from './types.js';

export const PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE =
  'Pending transfer middleware failed, keeping all messages';

export const PENDING_TRANSFER_MIDDLEWARE_QUERY_LIMIT_MESSAGE =
  'Pending transfer middleware would exceed the Explorer row limit before keeping the requested transfers';

/**
 * The most Explorer rows one user transfer query may ask for: 256 pages of the
 * default 100. Needing more means the middleware ignores an unexpectedly large
 * backlog, so the query fails instead of returning a partial page.
 */
export const MAX_EXPLORER_QUERY_LIMIT = 25_600;

/**
 * A query could not fill its limit under the Explorer row cap; `messages` is
 * the best page it got.
 */
export class ExplorerRowLimitError extends Error {
  constructor(
    message: string,
    readonly messages: ExplorerMessage[],
  ) {
    super(message);
    this.name = 'ExplorerRowLimitError';
  }
}

/**
 * Explorer client decorator that drops the pending user transfers it decides
 * will never be delivered, so their amounts are not reserved. Middlewares
 * chain: each one wraps the previous client and sees only what the inner
 * middlewares kept.
 *
 * Ignored messages count against the Explorer limit, so a query re-asks the
 * inner client with a larger limit, at least doubling it each time and capped
 * at `MAX_EXPLORER_QUERY_LIMIT`, until it keeps the requested number of
 * transfers or the Explorer has no more. If a full page at the cap still keeps
 * too few transfers, the query records what it ignored on that page, then
 * throws an `ExplorerRowLimitError` carrying its kept page, which an outer
 * middleware filters instead of failing outright.
 * Only messages within the returned page are evaluated: a tracked transfer
 * that falls outside it is not re-checked and stays reserved, as without
 * middlewares.
 */
export abstract class PendingTransferMiddleware implements IExplorerClient {
  private lastIgnored = new Map<string, string>();

  protected constructor(
    private readonly inner: IExplorerClient,
    readonly name: string,
  ) {}

  /**
   * Returns ignored message ids (lowercase) mapped to the reason. A message
   * whose status cannot be determined must not be ignored.
   */
  protected abstract findIgnored(
    messages: ExplorerMessage[],
    logger: Logger,
  ): Promise<Map<string, string>>;

  /**
   * Whether this middleware or any inner middleware ignored the message on
   * the latest user transfer query.
   */
  isIgnored(messageId: string): boolean {
    if (this.lastIgnored.has(normalizeMessageId(messageId))) return true;

    return (
      this.inner instanceof PendingTransferMiddleware &&
      this.inner.isIgnored(messageId)
    );
  }

  async getInflightUserTransfers(
    params: UserTransferQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    const requested = params.limit ?? DEFAULT_INFLIGHT_USER_TRANSFER_LIMIT;
    // Start with as many extra rows as this middleware dropped last time.
    let limit = Math.min(
      requested + this.lastIgnored.size,
      MAX_EXPLORER_QUERY_LIMIT,
    );
    let messages: ExplorerMessage[] = [];
    let found = new Map<string, string>();
    let overflow = false;

    for (;;) {
      let capped = false;
      try {
        messages = await this.inner.getInflightUserTransfers(
          {
            routersByDomain: params.routersByDomain,
            excludeTxSenders: params.excludeTxSenders,
            limit,
          },
          logger,
        );
      } catch (error: unknown) {
        // The inner client hit the row cap, but its page may still hold enough.
        if (!(error instanceof ExplorerRowLimitError)) throw error;
        messages = error.messages;
        capped = true;
      }
      found = await this.findIgnoredSafely(messages, logger);

      const ignoredCount = messages.filter((msg) =>
        found.has(normalizeMessageId(msg.msg_id)),
      ).length;
      const kept = messages.length - ignoredCount;
      const exhausted = !capped && messages.length < limit;
      if (kept >= requested || exhausted) break;

      if (capped || limit === MAX_EXPLORER_QUERY_LIMIT) {
        overflow = true;
        break;
      }
      limit = Math.min(
        MAX_EXPLORER_QUERY_LIMIT,
        Math.max(limit * 2, requested + ignoredCount),
      );
    }

    const ignored = new Map<string, string>();
    const kept: ExplorerMessage[] = [];
    for (const msg of messages) {
      const id = normalizeMessageId(msg.msg_id);
      const reason = found.get(id);

      if (reason === undefined) {
        kept.push(msg);
        if (this.lastIgnored.has(id)) {
          logger.info(
            { msgId: msg.msg_id, middleware: this.name },
            'Pending transfer no longer ignored',
          );
        }
        continue;
      }

      ignored.set(id, reason);
      if (this.lastIgnored.get(id) !== reason) {
        logger.info(
          {
            msgId: msg.msg_id,
            origin: msg.origin_domain_id,
            destination: msg.destination_domain_id,
            amount: this.parseAmount(msg, logger),
            middleware: this.name,
            reason,
          },
          'Ignoring pending transfer',
        );
      }
    }

    this.lastIgnored = ignored;

    if (overflow) {
      throw new ExplorerRowLimitError(
        `${PENDING_TRANSFER_MIDDLEWARE_QUERY_LIMIT_MESSAGE} (middleware ${this.name}, requested ${requested}, kept ${kept.length} of ${messages.length} rows, limit ${MAX_EXPLORER_QUERY_LIMIT})`,
        kept,
      );
    }
    return kept;
  }

  private async findIgnoredSafely(
    messages: ExplorerMessage[],
    logger: Logger,
  ): Promise<Map<string, string>> {
    try {
      return await this.findIgnored(messages, logger);
    } catch (error: unknown) {
      logger.warn(
        {
          middleware: this.name,
          error: error instanceof Error ? error.message : String(error),
        },
        PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE,
      );
      return new Map();
    }
  }

  getInflightRebalanceActions(
    params: RebalanceActionQueryParams,
    logger: Logger,
  ): Promise<ExplorerMessage[]> {
    return this.inner.getInflightRebalanceActions(params, logger);
  }

  private parseAmount(msg: ExplorerMessage, logger: Logger): string | null {
    try {
      return parseWarpRouteMessage(msg.message_body).amount.toString();
    } catch (error: unknown) {
      logger.debug(
        {
          msgId: msg.msg_id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not parse amount of ignored pending transfer',
      );
      return null;
    }
  }
}
