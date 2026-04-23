import { expect } from 'vitest';

import { coerceStringArray } from './options.js';

describe('options', () => {
  describe('coerceStringArray', () => {
    it('returns values unchanged when no trimming needed', () => {
      expect(coerceStringArray(['foo', 'bar', 'baz'])).toEqual([
        'foo',
        'bar',
        'baz',
      ]);
    });

    it('trims leading and trailing whitespace', () => {
      expect(coerceStringArray(['  foo', 'bar  ', '  baz  '])).toEqual([
        'foo',
        'bar',
        'baz',
      ]);
    });

    it('filters out empty strings', () => {
      expect(coerceStringArray(['foo', '', 'bar'])).toEqual(['foo', 'bar']);
    });

    it('filters out whitespace-only strings', () => {
      expect(coerceStringArray(['foo', '   ', 'bar', '\t'])).toEqual([
        'foo',
        'bar',
      ]);
    });

    it('returns empty array when all inputs are empty', () => {
      expect(coerceStringArray(['', '   ', ''])).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(coerceStringArray([])).toEqual([]);
    });

    it('handles mixed valid and invalid inputs', () => {
      expect(coerceStringArray(['  valid1  ', '', '  ', 'valid2', ''])).toEqual(
        ['valid1', 'valid2'],
      );
    });
  });
});
