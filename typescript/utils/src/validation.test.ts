import { expect } from 'vitest';

import { assert } from './validation.js';

describe('assert', () => {
  it('should not throw an error when the predicate is true', () => {
    expect(() => assert(true, 'Error message')).not.toThrow();
  });

  it('should throw an error when the predicate is false', () => {
    expect(() => assert(false, 'Error message')).toThrow('Error message');
  });
});
