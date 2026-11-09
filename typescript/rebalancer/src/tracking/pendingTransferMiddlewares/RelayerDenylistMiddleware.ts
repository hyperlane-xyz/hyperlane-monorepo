import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';

import { assert, sleep, timeout } from '@hyperlane-xyz/utils';

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

export const FETCH_TIMEOUT_MS = 10_000;

/** Startup fetch attempts and the delay between them, as in the relayer. */
const INITIAL_LOAD_ATTEMPTS = 3;
export const INITIAL_LOAD_RETRY_DELAY_MS = 2_000;

/** The relayer's limit on a denylist file, in bytes. */
export const MAX_DENYLIST_FILE_BYTES = 4 * 1024 * 1024;

export const RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE =
  'Relayer denylist refresh failed, keeping last good rules';

export const RELAYER_DENYLIST_INITIAL_LOAD_RETRY_MESSAGE =
  'Failed to fetch relayer denylist at startup, retrying';

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

function fileTooLarge(bytes: number): Error {
  return new Error(
    `Denylist file is at least ${bytes} bytes; the limit is ${MAX_DENYLIST_FILE_BYTES}`,
  );
}

/**
 * Decodes like the relayer's serde_json parser: invalid UTF-8 is an invalid
 * file, and a leading BOM is kept so `JSON.parse` rejects it.
 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new DenylistLoadError(
      DenylistLoadFailure.InvalidFile,
      'Invalid denylist JSON: not valid UTF-8',
    );
  }
}

/** Reads at most one byte past the relayer's limit, rejecting a larger file. */
async function readFileCapped(path: string): Promise<Uint8Array> {
  const file = await open(path);
  try {
    const buffer = Buffer.alloc(MAX_DENYLIST_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        bytes,
        buffer.length - bytes,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_DENYLIST_FILE_BYTES) throw fileTooLarge(bytes);

    return buffer.subarray(0, bytes);
  } finally {
    await file.close();
  }
}

/**
 * Reads at most the relayer's limit, rejecting a larger body before buffering
 * it. Cancels the body once `signal` aborts, as a fetch wrapper may not.
 */
async function readBodyCapped(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_DENYLIST_FILE_BYTES) throw fileTooLarge(length);

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  // A rejected cancel means the stream already errored, which ends the read too.
  const cancel = (): void => {
    void reader?.cancel().catch(() => {});
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;

    bytes += value.byteLength;
    if (bytes > MAX_DENYLIST_FILE_BYTES) {
      await reader.cancel();
      throw fileTooLarge(bytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

async function fetchBodyCapped(
  url: URL,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP status ${response.status}`);
  }

  return readBodyCapped(response, signal);
}

async function readDenylistBytes(url: URL): Promise<Uint8Array> {
  switch (url.protocol) {
    case 'file:':
      return readFileCapped(fileURLToPath(url));
    case 'http:':
    case 'https:': {
      // The timer settles the load even if the fetch ignores the abort.
      const controller = new AbortController();
      try {
        return await timeout(
          fetchBodyCapped(url, controller.signal),
          FETCH_TIMEOUT_MS,
          `Denylist fetch timed out after ${FETCH_TIMEOUT_MS} ms`,
        );
      } finally {
        controller.abort();
      }
    }
    default:
      throw new Error(`Unsupported denylist URL protocol ${url.protocol}`);
  }
}

export async function fetchDenylistFile(url: URL): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readDenylistBytes(url);
  } catch (error: unknown) {
    throw new DenylistLoadError(
      DenylistLoadFailure.FetchFailed,
      scrubUrl(error instanceof Error ? error.message : String(error), url),
    );
  }

  return decodeUtf8(bytes);
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

/** Retries fetch failures only: an invalid file stays invalid. */
async function loadInitialRules(
  source: DenylistSource,
  logger: Logger,
): Promise<DenylistRules> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loadRules(source, logger);
    } catch (error: unknown) {
      if (
        attempt >= INITIAL_LOAD_ATTEMPTS ||
        loadFailure(error) !== DenylistLoadFailure.FetchFailed
      ) {
        throw error;
      }

      logger.warn(
        {
          url: source.redactedUrl,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
        RELAYER_DENYLIST_INITIAL_LOAD_RETRY_MESSAGE,
      );
      await sleep(INITIAL_LOAD_RETRY_DELAY_MS);
    }
  }
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
 *
 * The relayer also skips its signer check, so it may deliver a message this
 * middleware ignores for its `origin_tx_sender` alone, when no dispatch tx
 * hash is stored (Cosmos block-level events, an old DB backlog, a zero hash),
 * the origin tx is not found (pruned or reorged out), the sender is zero
 * (Radix, Aleo) or the lookup keeps failing for about 8 minutes
 * (rust/main/agents/relayer/src/msg/pending_message.rs and
 * runtime_denylist.rs).
 *
 * The rebalancer's own rebalance messages are checked too, so a denied one is
 * not counted as incoming collateral.
 */
export class RelayerDenylistMiddleware extends PendingTransferMiddleware {
  protected override readonly ignoresRebalanceActions = true;
  private lastAttemptAt: number;
  private refreshing?: Promise<void>;

  private constructor(
    inner: IExplorerClient,
    private readonly source: DenylistSource,
    private rules: DenylistRules,
    private loadedAt: number,
  ) {
    super(inner, PendingTransferMiddlewareType.RelayerDenylist);

    this.lastAttemptAt = loadedAt;
  }

  /**
   * Loads the denylist, retrying fetch failures. Throws if it still cannot be
   * fetched or is invalid.
   */
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
      rules = await loadInitialRules(source, logger);
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

  private refreshIfStale(logger: Logger): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.lastAttemptAt < this.source.refreshIntervalMs) {
      return Promise.resolve();
    }

    this.lastAttemptAt = Date.now();
    this.refreshing = this.reload(logger).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async reload(logger: Logger): Promise<void> {
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
