import { describe, expect, it } from 'vitest';

import { parseCustomHeaders, stripCustomRpcHeaders } from './urlUtils.js';

describe('parseCustomHeaders', () => {
  it('extracts a single custom_rpc_header', () => {
    const url =
      'https://api.trongrid.io?custom_rpc_header=TRON-PRO-API-KEY:abc123';
    expect(parseCustomHeaders(url)).toEqual({
      'TRON-PRO-API-KEY': 'abc123',
    });
  });

  it('extracts multiple custom_rpc_header params', () => {
    const url =
      'https://host?custom_rpc_header=x-api-key:key1&custom_rpc_header=Authorization:Bearer%20token';
    expect(parseCustomHeaders(url)).toEqual({
      'x-api-key': 'key1',
      Authorization: 'Bearer token',
    });
  });

  it('handles header values with colons', () => {
    const url = 'https://host?custom_rpc_header=x-api-key:token:with:colons';
    expect(parseCustomHeaders(url)).toEqual({
      'x-api-key': 'token:with:colons',
    });
  });

  it('returns empty object for URL without custom_rpc_header', () => {
    const url = 'https://api.trongrid.io/jsonrpc';
    expect(parseCustomHeaders(url)).toEqual({});
  });

  it('returns empty object for invalid URL', () => {
    expect(parseCustomHeaders('not-a-url')).toEqual({});
  });

  it('ignores malformed header values without colon', () => {
    const url = 'https://host?custom_rpc_header=nocolon';
    expect(parseCustomHeaders(url)).toEqual({});
  });
});

describe('stripCustomRpcHeaders', () => {
  it('strips custom_rpc_header and returns clean URL with headers', () => {
    const url =
      'https://tron-mainnet.gateway.tatum.io/jsonrpc?custom_rpc_header=x-api-key:abc123';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).toBe('https://tron-mainnet.gateway.tatum.io/jsonrpc');
    expect(result.headers).toEqual({ 'x-api-key': 'abc123' });
  });

  it('preserves non-custom_rpc_header query params', () => {
    const url = 'https://host/jsonrpc?custom_rpc_header=x-api-key:abc&other=1';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).toBe('https://host/jsonrpc?other=1');
    expect(result.headers).toEqual({ 'x-api-key': 'abc' });
  });

  it('returns original URL unchanged when no custom_rpc_header', () => {
    const url = 'https://api.trongrid.io/jsonrpc';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).toBe(url);
    expect(result.headers).toEqual({});
  });

  it('returns original URL unchanged when xApiKey query param is used', () => {
    const url = 'https://tron-mainnet.gateway.tatum.io/jsonrpc?xApiKey=abc123';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).toBe(url);
    expect(result.headers).toEqual({});
  });

  it('strips malformed custom_rpc_header without colon', () => {
    const url = 'https://host/jsonrpc?custom_rpc_header=nocolon';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).toBe('https://host/jsonrpc');
    expect(result.headers).toEqual({});
  });
});
