import { assert, timeout } from '@hyperlane-xyz/utils';

/** Bound headers and body consumption even when fetch ignores cancellation. */
export async function fetchWithDeadline<T>(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  assert(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    'HTTP request timeout must be finite and positive',
  );
  const controller = new AbortController();
  try {
    return await timeout(
      (async () => {
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return consume(response);
      })(),
      timeoutMs,
      `HTTP request timed out after ${timeoutMs}ms`,
    );
  } finally {
    // Cleanup is best effort: waiting for body.cancel() can itself hang.
    controller.abort();
  }
}
