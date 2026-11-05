import { expect } from 'chai';

import { parseCustomRpcHeaders } from './provider.js';

describe('parseCustomRpcHeaders', () => {
  it('preserves URLs without query parameters, including invalid input', () => {
    for (const url of [
      'https://HOST:443/path',
      'https://[::1]:8545/path#custom_rpc_header=x-key:secret',
      'not-a-url',
    ]) {
      expect(parseCustomRpcHeaders(url)).to.deep.equal({
        url,
        headers: {},
        redactedHeaders: {},
      });
    }
  });

  it('decodes encoded header parameter names and redacts the last duplicate', () => {
    expect(
      parseCustomRpcHeaders(
        'https://HOST:443/path?%63ustom_rpc_header=x-key:first&custom_rpc_header=x-key:last%3Atoken&other=a%20b#fragment',
      ),
    ).to.deep.equal({
      url: 'https://host/path?other=a+b#fragment',
      headers: { 'x-key': 'last:token' },
      redactedHeaders: { 'x-key': '[REDACTED]' },
    });
  });

  it('ignores header-like path and fragment contents', () => {
    const url =
      'https://host/custom_rpc_header=x?other=1#custom_rpc_header=x:y';
    expect(parseCustomRpcHeaders(url)).to.deep.equal({
      url,
      headers: {},
      redactedHeaders: {},
    });
  });
});
