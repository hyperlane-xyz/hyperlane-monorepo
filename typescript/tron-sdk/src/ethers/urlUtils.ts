/**
 * Parse custom_rpc_header query params from a URL into a headers object.
 * e.g. "https://api.trongrid.io?custom_rpc_header=TRON-PRO-API-KEY:abc"
 * returns { "TRON-PRO-API-KEY": "abc" }
 */
export function parseCustomHeaders(url: string): Record<string, string> {
  if (!url.includes('?')) return {};
  try {
    return headersFromSearchParams(new URL(url).searchParams);
  } catch {
    // Not a valid URL, return empty headers
    return {};
  }
}

function headersFromSearchParams(
  params: URLSearchParams,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key !== 'custom_rpc_header') continue;
    const colonIdx = value.indexOf(':');
    if (colonIdx > 0) {
      headers[value.slice(0, colonIdx)] = value.slice(colonIdx + 1);
    }
  }
  return headers;
}

/**
 * Strip custom_rpc_header query params from a URL and return the clean URL
 * along with the extracted headers.
 *
 * e.g. "https://host/jsonrpc?custom_rpc_header=x-api-key:abc&other=1"
 * returns { url: "https://host/jsonrpc?other=1", headers: { "x-api-key": "abc" } }
 *
 * If no custom_rpc_header params are present, returns the original URL unchanged.
 */
export function stripCustomRpcHeaders(url: string): {
  url: string;
  headers: Record<string, string>;
} {
  if (!url.includes('?')) return { url, headers: {} };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, headers: {} };
  }
  const headers = headersFromSearchParams(parsed.searchParams);
  if (!parsed.searchParams.has('custom_rpc_header')) {
    return { url, headers };
  }
  parsed.searchParams.delete('custom_rpc_header');
  return { url: parsed.toString(), headers };
}

/**
 * Derive the Tron HTTP API base host from an RPC URL.
 *
 * TronWeb needs the base HTTP API host (serving `/wallet/*`), which differs
 * from the ethers JSON-RPC endpoint. This strips any `custom_rpc_header` query
 * params (they are auth headers, not part of the host) and a trailing
 * `/jsonrpc` path segment.
 *
 * e.g. "https://node.example.com/jsonrpc?custom_rpc_header=x-api-key:abc"
 * returns "https://node.example.com/"
 */
export function toHttpApiUrl(url: string): string {
  const parsed = new URL(url);
  // Avoid reserializing unrelated query parameters when there are no headers.
  if (parsed.searchParams.has('custom_rpc_header')) {
    parsed.searchParams.delete('custom_rpc_header');
  }
  if (parsed.pathname.endsWith('/jsonrpc')) {
    parsed.pathname = parsed.pathname.slice(0, -'/jsonrpc'.length);
  }
  return parsed.toString();
}
