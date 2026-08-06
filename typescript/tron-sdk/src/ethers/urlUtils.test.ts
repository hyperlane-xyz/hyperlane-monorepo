import { expect } from 'chai';

import {
  parseCustomHeaders,
  stripCustomRpcHeaders,
  toHttpApiUrl,
} from './urlUtils.js';

describe('parseCustomHeaders', () => {
  it('extracts a single custom_rpc_header', () => {
    const url =
      'https://api.trongrid.io?custom_rpc_header=TRON-PRO-API-KEY:abc123';
    expect(parseCustomHeaders(url)).to.deep.equal({
      'TRON-PRO-API-KEY': 'abc123',
    });
  });

  it('extracts multiple custom_rpc_header params', () => {
    const url =
      'https://host?custom_rpc_header=x-api-key:key1&custom_rpc_header=Authorization:Bearer%20token';
    expect(parseCustomHeaders(url)).to.deep.equal({
      'x-api-key': 'key1',
      Authorization: 'Bearer token',
    });
  });

  it('handles header values with colons', () => {
    const url = 'https://host?custom_rpc_header=x-api-key:token:with:colons';
    expect(parseCustomHeaders(url)).to.deep.equal({
      'x-api-key': 'token:with:colons',
    });
  });

  it('returns empty object for URL without custom_rpc_header', () => {
    const url = 'https://api.trongrid.io/jsonrpc';
    expect(parseCustomHeaders(url)).to.deep.equal({});
  });

  it('returns empty object for invalid URL', () => {
    expect(parseCustomHeaders('not-a-url')).to.deep.equal({});
  });

  it('ignores malformed header values without colon', () => {
    const url = 'https://host?custom_rpc_header=nocolon';
    expect(parseCustomHeaders(url)).to.deep.equal({});
  });
});

describe('stripCustomRpcHeaders', () => {
  it('strips custom_rpc_header and returns clean URL with headers', () => {
    const url =
      'https://tron-mainnet.gateway.tatum.io/jsonrpc?custom_rpc_header=x-api-key:abc123';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).to.equal(
      'https://tron-mainnet.gateway.tatum.io/jsonrpc',
    );
    expect(result.headers).to.deep.equal({ 'x-api-key': 'abc123' });
  });

  it('preserves non-custom_rpc_header query params', () => {
    const url = 'https://host/jsonrpc?custom_rpc_header=x-api-key:abc&other=1';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).to.equal('https://host/jsonrpc?other=1');
    expect(result.headers).to.deep.equal({ 'x-api-key': 'abc' });
  });

  it('returns original URL unchanged when no custom_rpc_header', () => {
    const url = 'https://api.trongrid.io/jsonrpc';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).to.equal(url);
    expect(result.headers).to.deep.equal({});
  });

  it('returns original URL unchanged when xApiKey query param is used', () => {
    const url = 'https://tron-mainnet.gateway.tatum.io/jsonrpc?xApiKey=abc123';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).to.equal(url);
    expect(result.headers).to.deep.equal({});
  });

  it('strips malformed custom_rpc_header without colon', () => {
    const url = 'https://host/jsonrpc?custom_rpc_header=nocolon';
    const result = stripCustomRpcHeaders(url);
    expect(result.url).to.equal('https://host/jsonrpc');
    expect(result.headers).to.deep.equal({});
  });
});

describe('toHttpApiUrl', () => {
  it('strips a trailing /jsonrpc path', () => {
    expect(toHttpApiUrl('https://node.example.com:8090/jsonrpc')).to.equal(
      'https://node.example.com:8090/',
    );
  });

  it('strips custom_rpc_header query params', () => {
    expect(
      toHttpApiUrl(
        'https://node.example.com/jsonrpc?custom_rpc_header=x-api-key:abc',
      ),
    ).to.equal('https://node.example.com/');
  });

  it('preserves a private/custom host', () => {
    const result = toHttpApiUrl('https://my-tron-node.example.com/jsonrpc');
    expect(result).to.contain('my-tron-node.example.com');
    expect(result).to.not.contain('trongrid');
  });

  it('leaves a plain host without /jsonrpc unchanged', () => {
    expect(toHttpApiUrl('https://node.example.com')).to.equal(
      'https://node.example.com/',
    );
  });

  it('returns a trongrid host as its own host', () => {
    const result = toHttpApiUrl('https://api.trongrid.io/jsonrpc');
    expect(result).to.contain('trongrid');
  });

  it('preserves non-custom_rpc_header query params', () => {
    expect(
      toHttpApiUrl(
        'https://host.example.com/jsonrpc?custom_rpc_header=x-api-key:abc&foo=bar',
      ),
    ).to.equal('https://host.example.com/?foo=bar');
  });

  it('leaves a non-trailing /jsonrpc path segment intact', () => {
    expect(toHttpApiUrl('https://host.example.com/jsonrpc/v1')).to.equal(
      'https://host.example.com/jsonrpc/v1',
    );
  });

  it('throws on invalid (non-URL) input', () => {
    expect(() => toHttpApiUrl('not-a-url')).to.throw();
  });

  // Provider-style URLs that carry the API key in the path (e.g. Alchemy:
  // https://tron-mainnet.g.alchemy.com/v2/<key>) must keep the host and path
  // verbatim, since the provider serves both eth JSON-RPC and the Tron HTTP API
  // under that base. A generic host is used here to avoid secret scanners.
  it('preserves a provider base URL with an api-key path segment (no /jsonrpc)', () => {
    expect(toHttpApiUrl('https://tron-rpc.example.com/v2/API_KEY')).to.equal(
      'https://tron-rpc.example.com/v2/API_KEY',
    );
  });

  it('strips only a trailing /jsonrpc from such a provider URL', () => {
    expect(
      toHttpApiUrl('https://tron-rpc.example.com/v2/API_KEY/jsonrpc'),
    ).to.equal('https://tron-rpc.example.com/v2/API_KEY');
  });
});
