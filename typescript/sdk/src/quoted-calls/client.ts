import type { Address, Hex } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { assert } from '@hyperlane-xyz/utils';

import type {
  AnyQuoteV2Entry,
  FeeQuotingCommand,
  FeeQuotingQuoteResponse,
  NoQuoteAvailableError as NoQuoteAvailableErrorBody,
  QuoteV2Endpoint,
  QuoteV2Response,
} from './types.js';
import {
  NO_QUOTE_AVAILABLE_ERROR,
  NoQuoteAvailableReason,
  QUOTE_V2_BASE_PATH,
  QuoteV2Endpoint as QuoteV2EndpointValues,
} from './types.js';

/** Runtime membership set for the `NoQuoteAvailableReason` discriminant. */
const NO_QUOTE_AVAILABLE_REASONS = new Set<string>(
  Object.values(NoQuoteAvailableReason),
);

export interface FeeQuotingClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface QuoteParams {
  origin: string;
  command: FeeQuotingCommand;
  router: Address;
  destination: number;
  /** Pre-computed salt (e.g. keccak256(sender, clientSalt) for QuotedCalls) */
  salt: Hex;
  /** Required for warp commands (transferRemote, transferRemoteTo) */
  recipient?: Hex;
  /** Target router for transferRemoteTo with CrossCollateralRoutingFee */
  targetRouter?: Hex;
}

export class FeeQuotingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: FeeQuotingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  async getQuote(params: QuoteParams): Promise<FeeQuotingQuoteResponse> {
    const query = new URLSearchParams({
      origin: params.origin,
      router: params.router,
      destination: String(params.destination),
      salt: params.salt,
    });

    if (params.recipient) query.set('recipient', params.recipient);
    if (params.targetRouter) query.set('targetRouter', params.targetRouter);

    const res = await fetch(
      `${this.baseUrl}/quote/${params.command}?${query}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Fee quoting request failed (${res.status}): ${(body as Record<string, string>).message ?? res.statusText}`,
      );
    }

    return res.json() as Promise<FeeQuotingQuoteResponse>;
  }
}

// ============================================================
// v2 client
// ============================================================
//
// v2 splits the v1 endpoint family by quoter type. Two routes:
//   GET {base}/v2/quote/warp  — token-fee program quote (`targetRouter` required)
//   GET {base}/v2/quote/igp   — IGP quote
//
// Success returns `QuoteV2Response { quote: AnyQuoteV2Entry }`. A 404 carries
// a `NoQuoteAvailableError` body — surfaced here as a typed JS error so
// callers can branch on `reason` without parsing JSON twice.

/** Query params for `GET /v2/quote/warp`. Mirrors the server-side route schema. */
export interface FeeQuotingV2WarpParams {
  origin: string;
  /** EVM hex or Sealevel base58 — server validates per protocol. */
  router: string;
  destination: number;
  /** bytes32 — already scope-mixed for transient mode. */
  salt: Hex;
  recipient: Hex;
  targetRouter: Hex;
  /** EVM hex or Sealevel base58 — payer / submitter address. */
  txSubmitter: string;
}

/** Query params for `GET /v2/quote/igp`. */
export interface FeeQuotingV2IgpParams {
  origin: string;
  router: string;
  destination: number;
  salt: Hex;
  txSubmitter: string;
}

/**
 * JS-level error mirroring the server-side 404 body
 * (`NoQuoteAvailableError` JSON shape from `types.ts`). Thrown by
 * `FeeQuotingV2Client` when the server returns 404 — callers can catch +
 * inspect `reason` / `detail` to decide whether to fall back to legacy
 * quoting or surface a clear "no quote available" UX.
 */
export class FeeQuotingNoQuoteAvailableError extends Error {
  readonly reason: NoQuoteAvailableReason;
  readonly detail: string;

  constructor(reason: NoQuoteAvailableReason, detail: string) {
    super(`No quote available (${reason}): ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Type guard for the `NoQuoteAvailableError` JSON body shape.
 *
 * Defined here so the constructor of `FeeQuotingNoQuoteAvailableError` can
 * stay narrow — we only want to interpret a 404 body as "no quote" when the
 * `error` discriminator matches; other 404s (e.g. nginx misroute) should
 * surface as the generic HTTP error.
 */
function isNoQuoteAvailableBody(
  body: unknown,
): body is NoQuoteAvailableErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Partial<NoQuoteAvailableErrorBody>;
  return (
    b.error === NO_QUOTE_AVAILABLE_ERROR &&
    typeof b.reason === 'string' &&
    NO_QUOTE_AVAILABLE_REASONS.has(b.reason) &&
    typeof b.detail === 'string'
  );
}

/** Type-predicate narrowing of `unknown` to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate a v2 success body before trusting it. The server signs these
 * responses, but a misrouted 2xx (empty `{}`, a reverse-proxy page coerced to
 * an object, or server/client schema drift) must fail loudly here rather than
 * returning `undefined`/mis-shaped data that only blows up later during
 * transaction construction.
 */
function isQuoteV2Response(body: unknown): body is QuoteV2Response {
  if (!isRecord(body) || !isRecord(body.quote)) return false;
  const quote = body.quote;
  if (
    typeof quote.quoter !== 'string' ||
    typeof quote.issuedAt !== 'number' ||
    typeof quote.expiry !== 'number' ||
    !isRecord(quote.details)
  ) {
    return false;
  }
  const details = quote.details;
  switch (quote.protocol) {
    case ProtocolType.Ethereum:
      return isRecord(details.quote) && typeof details.signature === 'string';
    case ProtocolType.Sealevel: {
      if (
        typeof details.domainId !== 'number' ||
        !isRecord(details.signedQuote)
      ) {
        return false;
      }
      const sq = details.signedQuote;
      return (
        typeof sq.context === 'string' &&
        typeof sq.data === 'string' &&
        typeof sq.issuedAt === 'string' &&
        typeof sq.expiry === 'string' &&
        typeof sq.clientSalt === 'string' &&
        typeof sq.signature === 'string'
      );
    }
    default:
      return false;
  }
}

export class FeeQuotingV2Client {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: FeeQuotingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  /** GET /v2/quote/warp. Throws `FeeQuotingNoQuoteAvailableError` on 404. */
  async getWarpQuote(params: FeeQuotingV2WarpParams): Promise<AnyQuoteV2Entry> {
    const query = new URLSearchParams({
      origin: params.origin,
      router: params.router,
      destination: String(params.destination),
      salt: params.salt,
      recipient: params.recipient,
      targetRouter: params.targetRouter,
      txSubmitter: params.txSubmitter,
    });
    return this.fetchQuote(QuoteV2EndpointValues.Warp, query);
  }

  /** GET /v2/quote/igp. Throws `FeeQuotingNoQuoteAvailableError` on 404. */
  async getIgpQuote(params: FeeQuotingV2IgpParams): Promise<AnyQuoteV2Entry> {
    const query = new URLSearchParams({
      origin: params.origin,
      router: params.router,
      destination: String(params.destination),
      salt: params.salt,
      txSubmitter: params.txSubmitter,
    });
    return this.fetchQuote(QuoteV2EndpointValues.Igp, query);
  }

  private async fetchQuote(
    endpoint: QuoteV2Endpoint,
    query: URLSearchParams,
  ): Promise<AnyQuoteV2Entry> {
    const res = await fetch(
      `${this.baseUrl}${QUOTE_V2_BASE_PATH}/${endpoint}?${query}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );

    // Parse once — Response.json() can only be consumed a single time per
    // response. A null body means the server returned a non-JSON 4xx/5xx
    // (e.g. an HTML error page from a reverse proxy).
    const body: unknown = await res.json().catch(() => null);

    if (res.status === 404 && isNoQuoteAvailableBody(body)) {
      throw new FeeQuotingNoQuoteAvailableError(body.reason, body.detail);
    }

    if (!res.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : res.statusText;
      throw new Error(
        `Fee quoting v2 request failed (${res.status}): ${message}`,
      );
    }

    assert(
      isQuoteV2Response(body),
      `Fee quoting v2 returned a malformed success body (HTTP ${res.status})`,
    );
    return body.quote;
  }
}
