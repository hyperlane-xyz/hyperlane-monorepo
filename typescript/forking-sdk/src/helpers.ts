import { assert } from '@hyperlane-xyz/utils';

const MAX_PORT = 65535;

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Resolves after `ms`, or rejects with the signal's abort reason the moment it
 * is aborted (clearing the pending timer so nothing lingers). A pre-aborted
 * signal rejects synchronously.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Allocates a contiguous block of ports starting at basePort.
 */
export function allocateSequentialPorts(
  basePort: number,
  count: number,
): number[] {
  assert(count >= 0, `Port count must be non-negative, got ${count}`);
  assert(
    Number.isInteger(basePort) && basePort > 0 && basePort <= MAX_PORT,
    `Base port must be an integer in (0, ${MAX_PORT}], got ${basePort}`,
  );

  if (count === 0) {
    return [];
  }

  const lastPort = basePort + count - 1;
  assert(
    lastPort <= MAX_PORT,
    `Port range ${basePort}-${lastPort} exceeds max port ${MAX_PORT}`,
  );

  return Array.from({ length: count }, (_, i) => basePort + i);
}

/**
 * Polls a readiness probe on a fixed interval until it resolves or the attempts
 * are exhausted, rethrowing the last error. Total wait is bounded by
 * `attempts * baseRetryMs`.
 */
export async function waitUntilReady(
  probe: () => Promise<unknown>,
  opts?: { attempts?: number; baseRetryMs?: number; signal?: AbortSignal },
): Promise<void> {
  const attempts = Math.max(1, opts?.attempts ?? 10);
  const baseRetryMs = opts?.baseRetryMs ?? 500;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (opts?.signal?.aborted) {
      throw toAbortError(opts.signal.reason);
    }
    try {
      await probe();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(baseRetryMs, opts?.signal);
      }
    }
  }

  throw lastError;
}
