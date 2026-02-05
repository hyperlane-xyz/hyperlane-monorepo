import { expect } from 'chai';

import { coerceStringArray } from './options.js';

describe('options', () => {
  describe('coerceStringArray', () => {
    it('returns values unchanged when no trimming needed', () => {
      expect(coerceStringArray(['foo', 'bar', 'baz'])).to.deep.equal([
        'foo',
        'bar',
        'baz',
      ]);
    });

    it('trims leading and trailing whitespace', () => {
      expect(coerceStringArray(['  foo', 'bar  ', '  baz  '])).to.deep.equal([
        'foo',
        'bar',
        'baz',
      ]);
    });

    it('filters out empty strings', () => {
      expect(coerceStringArray(['foo', '', 'bar'])).to.deep.equal([
        'foo',
        'bar',
      ]);
    });

    it('filters out whitespace-only strings', () => {
      expect(coerceStringArray(['foo', '   ', 'bar', '\t'])).to.deep.equal([
        'foo',
        'bar',
      ]);
    });

    it('returns empty array when all inputs are empty', () => {
      expect(coerceStringArray(['', '   ', ''])).to.deep.equal([]);
    });

    it('returns empty array for empty input', () => {
      expect(coerceStringArray([])).to.deep.equal([]);
    });

    it('handles mixed valid and invalid inputs', () => {
      expect(
        coerceStringArray(['  valid1  ', '', '  ', 'valid2', '']),
      ).to.deep.equal(['valid1', 'valid2']);
    });
  });
});
