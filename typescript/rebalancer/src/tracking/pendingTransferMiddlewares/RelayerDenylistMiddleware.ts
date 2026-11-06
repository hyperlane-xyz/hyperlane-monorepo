import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

import { assert } from '@hyperlane-xyz/utils';
import { readFileAtPath } from '@hyperlane-xyz/utils/fs';

import { PendingTransferMiddlewareType } from '../../config/types.js';
import type {
  ExplorerMessage,
  IExplorerClient,
} from '../../utils/ExplorerClient.js';

import { PendingTransferMiddleware } from './PendingTransferMiddleware.js';

import {
  DenylistLoadError,
  DenylistLoadFailure,
  type DenylistRules,
  findDenyReason,
  parseDenylistFile,
} from './relayerDenylistRules.js';
import { normalizeMessageId } from './types.js';

const FETCH_TIMEOUT_MS = 10_000;

export const RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE =
  'Relayer denylist refresh failed, keeping last good rules';

export const RELAYER_DENYLIST_CHECK_FAILED_MESSAGE =
  'Failed to check pending transfer against relayer denylist, keeping it';

export interface RelayerDenylistMiddlewareOptions {
  url: string;
  refreshIntervalMs: number;
}

interface DenylistSource {
  url: URL;
  redactedUrl: string;
  refreshIntervalMs: number;
}

/** Drops credentials, query and fragment, which may carry a token. */
export function redactUrl(url: string): string {
  const parsed = new URL(url);

  return parsed.protocol === 'file:'
    ? `file://${parsed.pathname}`
    : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** Removes the URL and its secret-bearing parts from an error message. */
function scrubUrl(message: string, url: URL): string {
  let scrubbed = message.split(url.href).join(redactUrl(url.href));
  for (const secret of [url.username, url.password, url.search]) {
    if (secret) scrubbed = scrubbed.split(secret).join('[redacted]');
  }

  return scrubbed;
}

export async function fetchDenylistFile(url: URL): Promise<string> {
  try {
    let text: string;
    switch (url.protocol) {
      case 'file:':
        text = readFileAtPath(fileURLToPath(url));
        break;
      case 'http:':
      case 'https:': {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP status ${response.status}`);
        }

        text = await response.text();
        break;
      }
      default:
        throw new Error(`Unsupported denylist URL protocol ${url.protocol}`);
    }

    return text;
  } catch (error: unknown) {
    throw new DenylistLoadError(
      DenylistLoadFailure.FetchFailed,
      scrubUrl(error instanceof Error ? error.message : String(error), url),
    );
  }
}

async function loadRules(
  source: DenylistSource,
  logger: Logger,
): Promise<DenylistRules> {
  const rules = parseDenylistFile(await fetchDenylistFile(source.url));

  logger.debug(
    {
      url: source.redactedUrl,
      matchRules: rules.matchRules.length,
      addressRules: rules.addressRules.length,
    },
    'Loaded relayer denylist',
  );
  return rules;
}

function loadFailure(error: unknown): DenylistLoadFailure {
  return error instanceof DenylistLoadError
    ? error.failure
    : DenylistLoadFailure.FetchFailed;
}

/**
 * Ignores messages the relayer's runtime denylist blocks. `create()` loads the
 * file; it is re-fetched once `refreshIntervalMs` has passed, and a failed
 * refresh keeps the last good rules.
 *
 * `address` rules are checked against the Explorer's `origin_tx_sender`, the
 * origin transaction's fee payer, where the relayer checks every origin
 * transaction signer. A denied depositor whose transaction another account
 * paid for (e.g. a sponsored Sealevel transfer) is therefore not ignored and
 * stays reserved.
 */
export class RelayerDenylistMiddleware extends PendingTransferMiddleware {
  private lastAttemptAt: number;

  private constructor(
    inner: IExplorerClient,
    private readonly source: DenylistSource,
    private rules: DenylistRules,
    private loadedAt: number,
  ) {
    super(inner, PendingTransferMiddlewareType.RelayerDenylist);

    this.lastAttemptAt = loadedAt;
  }

  /** Loads the denylist. Throws if it cannot be fetched or is invalid. */
  static async create(
    inner: IExplorerClient,
    options: RelayerDenylistMiddlewareOptions,
    logger: Logger,
  ): Promise<RelayerDenylistMiddleware> {
    const url = new URL(options.url);
    const redactedUrl = redactUrl(options.url);
    assert(
      url.username === '' && url.password === '',
      `Relayer denylist url ${redactedUrl} must not contain credentials`,
    );

    const source: DenylistSource = {
      url,
      redactedUrl,
      refreshIntervalMs: options.refreshIntervalMs,
    };

    let rules: DenylistRules;
    try {
      rules = await loadRules(source, logger);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load relayer denylist from ${redactedUrl} (${loadFailure(error)}): ${message}`,
      );
    }

    return new RelayerDenylistMiddleware(inner, source, rules, Date.now());
  }

  protected async findIgnored(
    messages: ExplorerMessage[],
    logger: Logger,
  ): Promise<Map<string, string>> {
    await this.refreshIfStale(logger);

    const now = Date.now();
    const ignored = new Map<string, string>();
    for (const msg of messages) {
      try {
        const reason = findDenyReason(this.rules, msg, now);
        if (reason !== undefined) {
          ignored.set(normalizeMessageId(msg.msg_id), reason);
        }
      } catch (error: unknown) {
        logger.warn(
          {
            msgId: msg.msg_id,
            error: error instanceof Error ? error.message : String(error),
          },
          RELAYER_DENYLIST_CHECK_FAILED_MESSAGE,
        );
      }
    }

    return ignored;
  }

  private async refreshIfStale(logger: Logger): Promise<void> {
    const now = Date.now();
    if (now - this.lastAttemptAt < this.source.refreshIntervalMs) return;

    this.lastAttemptAt = now;
    try {
      this.rules = await loadRules(this.source, logger);
      this.loadedAt = Date.now();
    } catch (error: unknown) {
      logger.warn(
        {
          url: this.source.redactedUrl,
          failure: loadFailure(error),
          cachedRulesAgeSecs: Math.floor((Date.now() - this.loadedAt) / 1000),
          error: error instanceof Error ? error.message : String(error),
        },
        RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE,
      );
    }
  }
}
