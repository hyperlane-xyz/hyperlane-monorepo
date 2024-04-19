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
 */
export async function runWithTimeout<T>(
  timeoutMs: number,
  callback: () => Promise<T>,
): Promise<T | void> {
  let timeout: NodeJS.Timeout;
  const timeoutProm = new Promise<void>(
    (_, reject) =>
      (timeout = setTimeout(
        () => reject(new Error(`Timed out in ${timeoutMs}ms.`)),
        timeoutMs,
      )),
  );
  const ret = await Promise.race([callback(), timeoutProm]);
  // @ts-ignore timeout gets set immediately by the promise constructor
  clearTimeout(timeout);
  return ret;
}

/**
 * Retries an async function if it raises an exception,
 *   using exponential backoff.
 * @param runner callback to run
 * @param attempts max number of attempts
 * @param baseRetryMs base delay between attempts
 * @returns runner return value
 */
export async function retryAsync<T>(
  runner: () => T,
  attempts = 5,
  baseRetryMs = 50,
) {
  let saveError;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await runner();
      return result;
    } catch (error) {
      saveError = error;
      await sleep(baseRetryMs * 2 ** i);
    }
  }
  throw saveError;
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
