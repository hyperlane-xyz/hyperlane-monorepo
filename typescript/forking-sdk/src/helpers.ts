import { assert, sleep } from '@hyperlane-xyz/utils';

const MAX_PORT = 65535;

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
  opts?: { attempts?: number; baseRetryMs?: number },
): Promise<void> {
  const attempts = Math.max(1, opts?.attempts ?? 10);
  const baseRetryMs = opts?.baseRetryMs ?? 500;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await probe();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(baseRetryMs);
      }
    }
  }

  throw lastError;
}
