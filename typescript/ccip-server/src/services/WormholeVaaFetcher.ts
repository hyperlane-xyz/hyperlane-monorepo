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
  maxAttempts: number;
  baseRetryDelayMs: number;
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
 * surrounding response metadata.
 */
export class WormholeVaaFetcher {
  constructor(
    private readonly serviceName: string,
    private readonly config: WormholeVaaFetcherConfig,
  ) {
    assert(config.urls.length > 0, 'At least one VAA endpoint is required');
  }

  async fetchVaa(
    emitterChainId: number,
    emitterAddress: string,
    sequence: string,
    logger: Logger,
  ): Promise<{ encodedVaa: string; vaa: ParsedVaa }> {
    const vaaId = formatVaaId(emitterChainId, emitterAddress, sequence);

    let lastPending: VaaPendingError | undefined;
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      for (const url of this.config.urls) {
        try {
          const encodedVaa = await this.fetchOnce(url, vaaId, logger);
          const vaa = parseVaa(encodedVaa);
          const servedVaaId = formatVaaId(
            vaa.emitterChainId,
            vaa.emitterAddress,
            vaa.sequence,
          );
          assert(
            servedVaaId === vaaId,
            `Endpoint served VAA ${servedVaaId} instead of ${vaaId}`,
          );
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
