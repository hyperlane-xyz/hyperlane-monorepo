import { BigNumber } from 'bignumber.js';

/**
 * Check if a value is number-like (e.g. valid numbers, bigNumber).
 * @param value The value to check.
 * @returns true/false.
 */
export function isNumberish(
  value: BigNumber.Value | undefined | null,
): boolean {
  try {
    const val = BigNumber(value!);
    return !val.isNaN() && val.isFinite() && BigNumber.isBigNumber(val);
  } catch {
    return false;
  }
}

/**
 * Check if a value (e.g. hex string or number) is zeroish (0, 0x0, 0x00, etc.).
 * @param value The value to check.
 * @returns true/false.
 */
export function isZeroish(value: BigNumber.Value): boolean {
  try {
    return BigNumber(value).isZero();
  } catch {
    return false;
  }
}
