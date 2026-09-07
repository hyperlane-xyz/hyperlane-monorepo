import { expect } from 'chai';
import { describe, it } from 'mocha';

import { signerConfigSchema } from '../src/roles.js';

describe('signerConfigSchema', () => {
  it('accepts an empty config', () => {
    expect(signerConfigSchema.parse({})).to.deep.equal({});
  });

  it('accepts a partial config', () => {
    expect(
      signerConfigSchema.parse({ ethereum: 'evm-deployer' }),
    ).to.deep.equal({ ethereum: 'evm-deployer' });
  });

  it('rejects unknown roles', () => {
    expect(() => signerConfigSchema.parse({ ethereum: 'nope' })).to.throw();
  });

  it('rejects roles from the wrong protocol', () => {
    expect(() =>
      signerConfigSchema.parse({ ethereum: 'sealevel-deployer' }),
    ).to.throw(/not a ethereum Turnkey role/);
  });
});
