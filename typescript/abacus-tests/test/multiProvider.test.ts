import { expect } from 'chai';
import { AbacusContext } from '@abacus-network/sdk';

describe('abacus sdk', () => {
  it('compiles', () => {
    expect(AbacusContext).to.not.be.undefined;
  });
});
