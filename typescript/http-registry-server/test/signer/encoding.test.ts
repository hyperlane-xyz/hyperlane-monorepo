import { expect } from 'chai';

import { isCanonicalBase64 } from '../../src/signer/encoding.js';

describe('isCanonicalBase64', () => {
  it('accepts canonical padded base64', () => {
    expect(isCanonicalBase64('YQ==')).to.equal(true);
    expect(isCanonicalBase64('YWI=')).to.equal(true);
    expect(isCanonicalBase64('YWJj')).to.equal(true);
  });

  it('rejects empty, unpadded, URL-safe, and malformed base64', () => {
    for (const value of ['', 'YQ', 'YQ=', 'YQ-_', '!!!!']) {
      expect(isCanonicalBase64(value)).to.equal(false);
    }
  });
});
