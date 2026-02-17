const REDACTED = '[REDACTED]';

export function parseCustomRpcHeaders(url: string): {
  url: string;
  headers: Record<string, string>;
  redactedHeaders: Record<string, string>;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, headers: {}, redactedHeaders: {} };
  }

  // Quick check: if no custom_rpc_header params exist, return original URL unchanged
  if (!parsed.searchParams.has('custom_rpc_header')) {
    return { url, headers: {}, redactedHeaders: {} };
  }

  const headers: Record<string, string> = {};
  const redactedHeaders: Record<string, string> = {};
  const retainedParams: [string, string][] = [];

  for (const [key, value] of parsed.searchParams) {
    if (key === 'custom_rpc_header') {
      // Use indexOf instead of split - header values can contain colons (e.g., "Bearer:token:with:colons")
      const colonIdx = value.indexOf(':');
      if (colonIdx > 0) {
        const headerName = value.slice(0, colonIdx);
        const headerValue = value.slice(colonIdx + 1);
        headers[headerName] = headerValue;
        redactedHeaders[headerName] = REDACTED;
      }
    } else {
      retainedParams.push([key, value]);
    }
  }

  parsed.search = '';
  retainedParams.forEach(([k, v]) => parsed.searchParams.append(k, v));

  return { url: parsed.toString(), headers, redactedHeaders };
}
