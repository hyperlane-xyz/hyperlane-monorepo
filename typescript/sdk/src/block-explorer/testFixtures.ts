export const EXPLORER_API_URL = 'https://explorer.example/api';
export const CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
export const CONTRACT_CREATOR = '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba';
export const DEPLOYMENT_TX_HASH = `0x${'ab'.repeat(32)}`;

// handleEtherscanResponse parses response.url, which a constructed Response
// leaves empty, so the request url is defined back onto the instance.
export function explorerResponse(body: unknown): Response {
  const response = new Response(JSON.stringify(body));
  Object.defineProperty(response, 'url', { value: EXPLORER_API_URL });
  return response;
}

export function explorerResultResponse(
  result: Record<string, unknown>,
): Response {
  return explorerResponse({ status: '1', message: 'OK', result: [result] });
}

export function explorerLogsResponse(logs: ReadonlyArray<unknown>): Response {
  return explorerResponse({ status: '1', message: 'OK', result: logs });
}
