import { expect } from 'vitest';

import {
  BPS_PRECISION,
  assertBpsPrecision,
  convertToBps,
  isBpsPrecisionValid,
} from './utils.js';

describe('isBpsPrecisionValid', () => {
  it('should return true for integer bps values', () => {
    expect(isBpsPrecisionValid(1)).toBe(true);
    expect(isBpsPrecisionValid(100)).toBe(true);
    expect(isBpsPrecisionValid(10000)).toBe(true);
  });

  it('should return true for values that are IEEE 754 edge cases', () => {
    // These were falsely rejected before the epsilon fix
    expect(isBpsPrecisionValid(0.1)).toBe(true);
    expect(isBpsPrecisionValid(0.3)).toBe(true);
    expect(isBpsPrecisionValid(33.33)).toBe(true);
  });

  it('should return true for valid fractional values up to 4 decimal places', () => {
    expect(isBpsPrecisionValid(1.5)).toBe(true);
    expect(isBpsPrecisionValid(0.0001)).toBe(true);
    expect(isBpsPrecisionValid(1.2345)).toBe(true);
  });

  it('should return false for values with more than 4 decimal places', () => {
    expect(isBpsPrecisionValid(0.00001)).toBe(false);
    expect(isBpsPrecisionValid(1.23456)).toBe(false);
  });
});

describe('assertBpsPrecision', () => {
  it('should not throw for valid fractional values including IEEE 754 edge cases', () => {
    expect(() => assertBpsPrecision(0.1)).not.toThrow();
    expect(() => assertBpsPrecision(0.3)).not.toThrow();
    expect(() => assertBpsPrecision(1.5)).not.toThrow();
    expect(() => assertBpsPrecision(0.0001)).not.toThrow();
  });

  it('should throw for values exceeding 4 decimal places', () => {
    expect(() => assertBpsPrecision(0.00001)).toThrow(
      /at most 4 decimal places/,
    );
    expect(() => assertBpsPrecision(1.23456)).toThrow(
      /at most 4 decimal places/,
    );
  });
});

describe('BPS_PRECISION', () => {
  it('should equal 10n ** 4n = 10000n', () => {
    expect(BPS_PRECISION).toBe(10000n);
  });
});

describe('convertToBps', () => {
  it('should throw for halfAmount = 0', () => {
    expect(() => convertToBps(100n, 0n)).toThrow(/halfAmount must be > 0/);
  });

  it('should return a number rounded to 4 decimal places', () => {
    const result = convertToBps(10n, 1000n);
    expect(result).toBeTypeOf('number');
    // Verify it rounds to at most 4 decimal places
    const decimals = result.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });
});
