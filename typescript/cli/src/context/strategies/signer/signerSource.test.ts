import { expect } from 'chai';

import { parseSignerSource, SignerSourceType } from './signerSource.js';

describe('parseSignerSource', () => {
  it('keeps private keys and mnemonics on the existing path', () => {
    expect(parseSignerSource('0x1234')).to.deep.equal({
      type: SignerSourceType.PRIVATE_KEY,
      privateKey: '0x1234',
    });
    expect(parseSignerSource('test test test')).to.deep.equal({
      type: SignerSourceType.PRIVATE_KEY,
      privateKey: 'test test test',
    });
  });

  for (const [url, expectedAddress] of [
    ['http://127.0.0.1:3333#0x1234', '0x1234'],
    ['http://[::1]:3333#svmAddress', 'svmAddress'],
  ]) {
    it(`accepts loopback signer URL ${url}`, () => {
      const result = parseSignerSource(url);
      expect(result.type).to.equal(SignerSourceType.HTTP);
      if (result.type === SignerSourceType.HTTP) {
        expect(result.url.hash).to.equal('');
        expect(result.expectedAddress).to.equal(expectedAddress);
      }
    });
  }

  for (const url of [
    'https://127.0.0.1:3333',
    'http://localhost:3333',
    'http://192.168.1.1:3333',
    'http://127.0.0.1',
    'http://127.0.0.1:3333',
    'http://127.0.0.1:3333#',
    'http://user:password@127.0.0.1:3333',
    'http://127.0.0.1:3333?token=secret#0x1234',
    'http://[::1]:3333/registry/#svmAddress',
  ]) {
    it(`rejects unsafe signer URL ${url}`, () => {
      expect(() => parseSignerSource(url)).to.throw();
    });
  }
});
