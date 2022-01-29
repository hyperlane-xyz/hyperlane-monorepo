import { expect } from 'chai';
import { OpticsContext } from 'optics-multi-provider-community';

describe('optics multi-provider', () => {
  it('compiles', () => {
    expect(OpticsContext).to.not.be.undefined;
  });
});
