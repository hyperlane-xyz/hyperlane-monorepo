import { expect } from 'chai';

import { isNullish, isNumeric } from './typeof.js';

describe('isNullish', () => {
  it('should return true for null', () => {
    expect(isNullish(null)).to.be.true;
  });

  it('should return true for undefined', () => {
    expect(isNullish(undefined)).to.be.true;
  });

  it('should return false for non-nullish values', () => {
    expect(isNullish('')).to.be.false;
    expect(isNullish(0)).to.be.false;
    expect(isNullish(false)).to.be.false;
  });
});

describe('isNumeric', () => {
  it('should return true for numeric strings', () => {
    expect(isNumeric('123')).to.be.true;
  });

  it('should return true for numbers', () => {
    expect(isNumeric(123)).to.be.true;
  });

  it('should return true for negative numbers', () => {
    expect(isNumeric(-123)).to.be.true;
  });

  it('should return true for floating point numbers', () => {
    expect(isNumeric(123.45)).to.be.true;
  });

  it('should return false for non-numeric strings', () => {
    expect(isNumeric('abc')).to.be.false;
    expect(isNumeric('123abc')).to.be.false;
  });
});
