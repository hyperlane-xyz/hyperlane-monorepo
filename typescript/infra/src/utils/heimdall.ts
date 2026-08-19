export const DEFAULT_HEIMDALL_URL = 'https://heimdall.tailb0554c.ts.net';

const HEIMDALL_REQUEST_TIMEOUT_MS = 10_000;
const HEIMDALL_REQUEST_ATTEMPTS = 3;
const HEIMDALL_RETRY_BASE_MS = 250;
const RETRYABLE_HEIMDALL_STATUSES = new Set([404, 429, 503]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestHeimdallSafeTxRefresh({
  baseUrl,
  chainName,
  safeAddress,
  safeTxHash,
  fetchFn = fetch,
  sleepFn = sleep,
}: {
  baseUrl: string;
  chainName: string;
  safeAddress: string;
  safeTxHash: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<string | undefined> {
  const origin = new URL(baseUrl).origin;
  const refreshUrl = new URL(
    `/api/v1/multisigs/${encodeURIComponent(chainName)}/${encodeURIComponent(safeAddress)}/txs/${encodeURIComponent(safeTxHash)}/refresh`,
    origin,
  );
  for (let attempt = 1; attempt <= HEIMDALL_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetchFn(refreshUrl, {
      method: 'POST',
      headers: {
        Origin: origin,
        'X-Heimdall-CSRF': '1',
      },
      signal: AbortSignal.timeout(HEIMDALL_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (
        attempt < HEIMDALL_REQUEST_ATTEMPTS &&
        RETRYABLE_HEIMDALL_STATUSES.has(response.status)
      ) {
        await sleepFn(HEIMDALL_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`Heimdall returned HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'canonicalUrl' in body &&
      typeof body.canonicalUrl === 'string'
    ) {
      return new URL(body.canonicalUrl, origin).toString();
    }
    return undefined;
  }

  throw new Error('Heimdall refresh exhausted without a response');
}
