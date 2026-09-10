import { ethers } from 'ethers';
import { Logger } from 'pino';

import { assert, sleep } from '@hyperlane-xyz/utils';

import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import { ParsedVaa, formatVaaId, parseVaa } from './wormholeVaaMatcher.js';

export interface WormholeVaaFetcherConfig {
  /** Redundant Wormholescan-compatible base URLs, tried in order. */
  urls: Array<string>;
  timeoutMs: number;
  maxResponseBytes: number;
  maxCacheEntries: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
}

interface CacheEntry {
  encodedVaa: string;
  guardianSetIndex: number;
}

/** Signals that Guardians have not signed yet; the relayer should retry later. */
export class VaaPendingError extends Error {
  constructor(vaaId: string) {
    super(`VAA ${vaaId} is pending Guardian signatures`);
    this.name = 'VaaPendingError';
  }
}

/**
 * Fetches signed VAAs from redundant public endpoints.
 *
 * The upstream is untrusted: only the decoded VAA bytes are used, never the
 * surrounding response metadata. A VAA ID is immutable once signed, so
 * successful results are held in a bounded LRU cache alongside the
 * Guardian-set index they were signed under.
 */
export class WormholeVaaFetcher {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly serviceName: string,
    private readonly config: WormholeVaaFetcherConfig,
  ) {
    assert(config.urls.length > 0, 'At least one VAA endpoint is required');
    assert(
      config.maxCacheEntries > 0,
      'VAA cache must allow at least one entry',
    );
  }

  async fetchVaa(
    emitterChainId: number,
    emitterAddress: string,
    sequence: string,
    logger: Logger,
  ): Promise<{ encodedVaa: string; vaa: ParsedVaa }> {
    const vaaId = formatVaaId(emitterChainId, emitterAddress, sequence);

    const cached = this.cache.get(vaaId);
    if (cached) {
      // Map preserves insertion order. Reinsert to mark this entry as newest.
      this.cache.delete(vaaId);
      this.cache.set(vaaId, cached);
      logger.info({ vaaId }, 'Serving VAA from immutable cache');
      return {
        encodedVaa: cached.encodedVaa,
        vaa: parseVaa(cached.encodedVaa),
      };
    }

    let lastPending: VaaPendingError | undefined;
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      for (const url of this.config.urls) {
        try {
          const encodedVaa = await this.fetchOnce(url, vaaId, logger);
          const vaa = parseVaa(encodedVaa);
          this.cache.set(vaaId, {
            encodedVaa,
            guardianSetIndex: vaa.guardianSetIndex,
          });
          this.evictOldestCacheEntries();
          logger.info(
            { vaaId, guardianSetIndex: vaa.guardianSetIndex, attempt },
            'Fetched signed VAA',
          );
          return { encodedVaa, vaa };
        } catch (error) {
          if (error instanceof VaaPendingError) {
            lastPending = error;
            continue;
          }
          // Endpoint-level failure: try the next endpoint, then the next attempt.
          logger.warn(
            { vaaId, url, error: errorMessage(error) },
            'VAA endpoint failed',
          );
        }
      }

      if (attempt + 1 < this.config.maxAttempts) {
        await sleep(this.backoffMs(attempt));
      }
    }

    PrometheusMetrics.logUnhandledError(
      this.serviceName,
      UnhandledErrorReason.WORMHOLE_VAA_UNAVAILABLE,
    );
    if (lastPending) throw lastPending;
    throw new Error(`Unable to fetch VAA ${vaaId} from any endpoint`);
  }

  /** Exponential backoff with jitter, so retries do not synchronize. */
  private backoffMs(attempt: number): number {
    const base = this.config.baseRetryDelayMs * 2 ** attempt;
    return base + Math.floor(Math.random() * this.config.baseRetryDelayMs);
  }

  private evictOldestCacheEntries(): void {
    while (this.cache.size > this.config.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      assert(oldest !== undefined, 'Non-empty cache must have an oldest entry');
      this.cache.delete(oldest);
    }
  }

  private async fetchOnce(
    baseUrl: string,
    vaaId: string,
    logger: Logger,
  ): Promise<string> {
    const url = `${baseUrl.replace(/\/$/, '')}/api/v1/vaas/${vaaId}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { accept: 'application/json' },
    });

    if (response.status === 404) {
      PrometheusMetrics.logUnhandledError(
        this.serviceName,
        UnhandledErrorReason.WORMHOLE_VAA_PENDING,
      );
      throw new VaaPendingError(vaaId);
    }
    assert(
      response.ok,
      `VAA endpoint returned ${response.status} for ${vaaId}`,
    );

    const body = await readBoundedResponseBody(
      response,
      this.config.maxResponseBytes,
      vaaId,
    );

    const parsed: unknown = JSON.parse(body);
    const encoded = extractVaaField(parsed);
    if (encoded === undefined) {
      // A well-formed response with no VAA yet is a pending attestation, not a
      // permanent failure.
      logger.info({ vaaId, url }, 'Endpoint has no VAA yet');
      throw new VaaPendingError(vaaId);
    }

    return decodeBase64OrHex(encoded);
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxResponseBytes: number,
  vaaId: string,
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    assert(
      Number.isSafeInteger(declaredLength) && declaredLength >= 0,
      `VAA response for ${vaaId} has invalid content-length`,
    );
    assert(
      declaredLength <= maxResponseBytes,
      `VAA response for ${vaaId} exceeds ${maxResponseBytes} bytes`,
    );
  }

  assert(response.body, `VAA response for ${vaaId} has no body`);
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      assert(
        receivedBytes <= maxResponseBytes,
        `VAA response for ${vaaId} exceeds ${maxResponseBytes} bytes`,
      );
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }

  return Buffer.concat(chunks, receivedBytes).toString('utf8');
}

function extractVaaField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = 'data' in body ? body.data : undefined;
  if (typeof data !== 'object' || data === null) return undefined;
  const vaa = 'vaa' in data ? data.vaa : undefined;
  return typeof vaa === 'string' && vaa.length > 0 ? vaa : undefined;
}

/** Wormholescan returns base64; accept hex too so other mirrors work. */
export function decodeBase64OrHex(value: string): string {
  if (ethers.utils.isHexString(value)) return value;
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.length > 0, 'Endpoint returned an empty VAA');
  return ethers.utils.hexlify(bytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
