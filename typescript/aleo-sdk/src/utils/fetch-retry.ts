import { sleep } from '@hyperlane-xyz/utils';

import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from './helper.js';

// The @provablehq/sdk runs snarkVM in WASM, which calls globalThis.fetch to
// load each imported program (/program/<id>) during buildDeploymentTransaction.
// Aleo explorer nodes return transient 5xx / connection-reset errors, and a
// single failure aborts the deploy after expensive local proof work.
//
// We can't intercept those WASM-internal calls any other way, but globally
// patching fetch has a wide blast radius (read-only providers, unrelated
// caller code, non-idempotent POSTs amplified by other retry layers). So this
// helper wraps the patch in a try/finally scope and only retries idempotent
// reads (GET/HEAD) on transient failures.
//
let fetchRetryLock: Promise<void> = Promise.resolve();

export interface FetchRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  shouldRetryResponse?: (
    res: Response,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => boolean;
  shouldRetryError?: (
    err: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => boolean;
}

function getMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && 'method' in input) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function isIdempotent(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = getMethod(input, init);
  return method === 'GET' || method === 'HEAD';
}

function defaultShouldRetryResponse(
  res: Response,
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  if (!isIdempotent(input, init)) return false;
  return res.status >= 500 && res.status < 600;
}

function defaultShouldRetryError(
  err: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Only retry network errors on idempotent reads. A POST that errors
  // may have already been received by the server; resubmitting risks
  // duplicate broadcasts or "already seen" rejections.
  return isIdempotent(input, init);
}

export async function withAleoFetchRetry<T>(
  callback: () => Promise<T>,
  options: FetchRetryOptions = {},
): Promise<T> {
  let releaseLock!: () => void;
  const previousLock = fetchRetryLock;
  fetchRetryLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await previousLock;

  if (typeof globalThis.fetch !== 'function') {
    releaseLock();
    throw new Error('withAleoFetchRetry requires globalThis.fetch');
  }

  try {
    const {
      attempts = RETRY_ATTEMPTS,
      baseDelayMs = RETRY_DELAY_MS,
      shouldRetryResponse = defaultShouldRetryResponse,
      shouldRetryError = defaultShouldRetryError,
    } = options;

    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async (input, init) => {
      let lastErr: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          const res = await originalFetch(input, init);
          if (shouldRetryResponse(res, input, init) && i < attempts - 1) {
            await sleep(baseDelayMs * 2 ** i);
            continue;
          }
          return res;
        } catch (err) {
          lastErr = err;
          if (!shouldRetryError(err, input, init) || i === attempts - 1) {
            throw err;
          }
          await sleep(baseDelayMs * 2 ** i);
        }
      }
      throw lastErr;
    };

    try {
      return await callback();
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    releaseLock();
  }
}
