import type { Logger } from 'pino';

import { rootLogger } from './logging.js';
import { assert } from './validation.js';

interface Recoverable {
  isRecoverable?: boolean;
}

/**
 * Return a promise that resolves in ms milliseconds.
 * @param ms Time to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait up to a given amount of time, and throw an error if the promise does not resolve in time.
 * @param promise The promise to timeout on.
 * @param timeoutMs How long to wait for the promise in milliseconds.
 * @param message The error message if a timeout occurs.
 */
export function timeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  message = 'Timeout reached',
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(resolve).catch(reject);
  });
}

/**
 * Run a callback with a timeout.
 * @param timeoutMs How long to wait for the promise in milliseconds.
 * @param callback The callback to run.
 * @returns callback return value
 * @throws Error if the timeout is reached before the callback completes
 */
export async function runWithTimeout<T>(
  timeoutMs: number,
  callback: () => Promise<T>,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutProm = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out in ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([callback(), timeoutProm]);
    return result as T;
  } finally {
    // @ts-ignore timeout gets set immediately by the promise constructor
    clearTimeout(timeoutId);
  }
}

/**
 * Executes a fetch request that fails after a timeout via an AbortController.
 * @param resource resource to fetch (e.g URL)
 * @param options fetch call options object
 * @param timeout timeout MS (default 10_000)
 * @returns fetch response
 */
export async function fetchWithTimeout(
  resource: RequestInfo,
  options?: RequestInit,
  timeout = 10_000,
) {
  const controller = new AbortController();
  const id = setTimeout(controller.abort.bind(controller), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal,
  });
  clearTimeout(id);
  return response;
}

/**
 * Retries an async function with exponential backoff.
 * Always executes at least once, even if `attempts` is 0 or negative.
 * Stops retrying if `error.isRecoverable` is set to false.
 * @param runner callback to run
 * @param attempts max number of attempts (defaults to 5, minimum 1)
 * @param baseRetryMs base delay between attempts in milliseconds (defaults to 50ms)
 * @returns runner return value
 */
export async function retryAsync<T>(
  runner: () => Promise<T> | T,
  attempts = 5,
  baseRetryMs = 50,
) {
  // Guard against invalid attempts - always try at least once
  attempts = attempts > 0 ? attempts : 1;

  let i = 0;
  for (;;) {
    try {
      const result = await runner();
      return result;
    } catch (e) {
      const error = e as Error & Recoverable;

      // Non-recoverable only if the flag is present _and_ set to false
      if (error.isRecoverable === false || ++i >= attempts) {
        throw error;
      }

      await sleep(baseRetryMs * 2 ** (i - 1));
    }
  }
}

/**
 * Run a callback with a timeout, and retry if the callback throws an error.
 * @param runner callback to run
 * @param delayMs base delay between attempts
 * @param maxAttempts maximum number of attempts
 * @returns runner return value
 */
export async function pollAsync<T>(
  runner: () => Promise<T>,
  delayMs = 500,
  maxAttempts: number | undefined = undefined,
) {
  let attempts = 0;
  let saveError;
  while (!maxAttempts || attempts < maxAttempts) {
    try {
      const ret = await runner();
      return ret;
    } catch (error) {
      rootLogger.debug(`Error in pollAsync`, { error });
      saveError = error;
      attempts += 1;
      await sleep(delayMs);
    }
  }
  throw saveError;
}

/**
 * An enhanced Promise.race that returns
 * objects with the promise itself and index
 * instead of just the resolved value.
 */
export async function raceWithContext<T>(
  promises: Array<Promise<T>>,
): Promise<{ resolved: T; promise: Promise<T>; index: number }> {
  const promisesWithContext = promises.map((p, i) =>
    p.then((resolved) => ({ resolved, promise: p, index: i })),
  );
  return Promise.race(promisesWithContext);
}

/**
 * Map an async function over a list xs with a given concurrency level
 * Forked from https://github.com/celo-org/developer-tooling/blob/0c61e7e02c741fe10ecd1d733a33692d324cdc82/packages/sdk/base/src/async.ts#L128
 *
 * @param concurrency number of `mapFn` concurrent executions
 * @param xs list of value
 * @param mapFn mapping function
 */
export async function concurrentMap<A, B>(
  concurrency: number,
  xs: A[],
  mapFn: (val: A, idx: number) => Promise<B>,
): Promise<B[]> {
  let res: B[] = [];
  assert(concurrency > 0, 'concurrency must be greater than 0');
  for (let i = 0; i < xs.length; i += concurrency) {
    const remaining = xs.length - i;
    const sliceSize = Math.min(remaining, concurrency);
    const slice = xs.slice(i, i + sliceSize);
    res = res.concat(
      await Promise.all(slice.map((elem, index) => mapFn(elem, i + index))),
    );
  }
  return res;
}

/**
 * Result type for mapAllSettled containing both successful results and errors.
 */
export interface AllSettledResult<K, R> {
  /** Map of keys to their successfully resolved values */
  fulfilled: Map<K, R>;
  /** Map of keys to their rejection errors */
  rejected: Map<K, Error>;
}

/**
 * Maps an async function over items using Promise.allSettled semantics.
 * Unlike Promise.all, this continues processing all items even if some fail.
 *
 * @param items - Array of items to process
 * @param mapFn - Async function to apply to each item
 * @param keyFn - Optional function to derive a key for each item (defaults to using index)
 * @returns Object with `fulfilled` Map (successful results) and `rejected` Map (errors)
 *
 * @example
 * ```typescript
 * // Process chains and collect results/errors
 * const { fulfilled, rejected } = await mapAllSettled(
 *   chains,
 *   async (chain) => deployContract(chain),
 *   (chain) => chain, // use chain name as key
 * );
 *
 * // Handle errors if any
 * if (rejected.size > 0) {
 *   const errors = [...rejected.entries()].map(([chain, err]) => `${chain}: ${err.message}`);
 *   throw new Error(`Deployment failed: ${errors.join('; ')}`);
 * }
 *
 * // Use successful results
 * for (const [chain, result] of fulfilled) {
 *   console.log(`Deployed to ${chain}: ${result}`);
 * }
 * ```
 */
export async function mapAllSettled<T, R, K = number>(
  items: T[],
  mapFn: (item: T, index: number) => Promise<R>,
  keyFn?: (item: T, index: number) => K,
): Promise<AllSettledResult<K, R>> {
  const results = await Promise.allSettled(
    items.map((item, index) => mapFn(item, index)),
  );

  const fulfilled = new Map<K, R>();
  const rejected = new Map<K, Error>();

  results.forEach((result, index) => {
    const key = keyFn ? keyFn(items[index], index) : (index as unknown as K);

    if (result.status === 'fulfilled') {
      fulfilled.set(key, result.value);
    } else {
      const error =
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));
      rejected.set(key, error);
    }
  });

  return { fulfilled, rejected };
}

/**
 * Wraps an async function and catches any errors, logging them instead of throwing.
 * Useful for fire-and-forget operations where you want to log errors but not crash.
 *
 * @param fn - The async function to execute
 * @param context - A description of the context for error logging
 * @param logger - The logger instance to use for error logging
 */
export async function tryFn(
  fn: () => Promise<void>,
  context: string,
  logger: Logger,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error({ context, err: error as Error }, `Error in ${context}`);
  }
}

export async function timedAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const result = await fn();
  rootLogger.trace(`Timing: ${name} took ${Date.now() - start}ms`);
  return result;
}
