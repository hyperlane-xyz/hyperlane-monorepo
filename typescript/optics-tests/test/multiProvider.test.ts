import { expect } from 'chai';
import { OpticsContext } from '@abacus-network/sdk';

describe('optics multi-provider', () => {
  it('compiles', () => {
    expect(OpticsContext).to.not.be.undefined;
  });
});
