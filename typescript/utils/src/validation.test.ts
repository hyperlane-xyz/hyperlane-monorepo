import { expect } from 'chai';

import { assert } from './validation.js';

describe('assert', () => {
  it('should not throw an error when the predicate is true', () => {
    expect(() => assert(true, 'Error message')).to.not.throw();
  });

  it('should throw an error when the predicate is false', () => {
    expect(() => assert(false, 'Error message')).to.throw('Error message');
  });
});
