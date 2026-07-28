import { expect } from 'chai';

import { validatorMetadataRpcUrlHash } from './types.js';

describe('validatorMetadataRpcUrlHash', () => {
  it('returns the entry itself for the historical (pre-v1.6.0) string shape', () => {
    expect(validatorMetadataRpcUrlHash('0xabc')).to.equal('0xabc');
  });

  it('returns url_hash for the current { url_hash, host_hash } object shape', () => {
    expect(
      validatorMetadataRpcUrlHash({ url_hash: '0xabc', host_hash: '0xdef' }),
    ).to.equal('0xabc');
  });
});
