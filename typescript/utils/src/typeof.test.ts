import { expect } from 'vitest';

import { isNullish, isNumeric } from './typeof.js';

describe('isNullish', () => {
  it('should return true for null', () => {
    expect(isNullish(null)).toBe(true);
  });

  it('should return true for undefined', () => {
    expect(isNullish(undefined)).toBe(true);
  });

  it('should return false for non-nullish values', () => {
    expect(isNullish('')).toBe(false);
    expect(isNullish(0)).toBe(false);
    expect(isNullish(false)).toBe(false);
  });
});

describe('isNumeric', () => {
  it('should return true for numeric strings', () => {
    expect(isNumeric('123')).toBe(true);
  });

  it('should return true for numbers', () => {
    expect(isNumeric(123)).toBe(true);
  });

  it('should return true for negative numbers', () => {
    expect(isNumeric(-123)).toBe(true);
  });

  it('should return true for floating point numbers', () => {
    expect(isNumeric(123.45)).toBe(true);
  });

  it('should return false for non-numeric strings', () => {
    expect(isNumeric('abc')).toBe(false);
    expect(isNumeric('123abc')).toBe(false);
  });
});
