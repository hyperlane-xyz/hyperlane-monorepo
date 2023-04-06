import fetch from 'cross-fetch';

// Adapted from https://github.com/node-fetch/node-fetch#request-cancellation-with-abortsignal
export async function fetchWithTimeout(
  url: RequestInfo | URL,
  options?: RequestInit,
  timeout = 10000,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeoutId),
  );
}
