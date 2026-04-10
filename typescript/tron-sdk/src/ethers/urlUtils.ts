/**
 * Parse custom_rpc_header query params from a URL into a headers object.
 * e.g. "https://api.trongrid.io?custom_rpc_header=TRON-PRO-API-KEY:abc"
 * returns { "TRON-PRO-API-KEY": "abc" }
 */
export function parseCustomHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams) {
      if (key !== 'custom_rpc_header') continue;
      const colonIdx = value.indexOf(':');
      if (colonIdx > 0) {
        headers[value.slice(0, colonIdx)] = value.slice(colonIdx + 1);
      }
    }
  } catch {
    // Not a valid URL, return empty headers
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
  const headers = parseCustomHeaders(url);
  if (Object.keys(headers).length === 0) {
    return { url, headers };
  }
  const parsed = new URL(url);
  parsed.searchParams.delete('custom_rpc_header');
  return { url: parsed.toString(), headers };
}
