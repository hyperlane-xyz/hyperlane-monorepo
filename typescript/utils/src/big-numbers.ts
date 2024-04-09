import { BigNumber } from 'bignumber.js';
import { FixedNumber } from 'ethers';

// Use toString(10) on bignumber.js to prevent ethers.js bigNumber error
// when parsing exponential string over e21

/**
 * Check if a value is bigNumberish (e.g. valid numbers, bigNumber).
 * @param value The value to check.
 * @returns true/false.
 */
export function isBigNumberish(
  value: BigNumber.Value | undefined | null,
): boolean {
  try {
    const val = BigNumber(value!);
    return !val.isNaN() && val.isFinite() && BigNumber.isBigNumber(val);
  } catch (error) {
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
  } catch (error) {
    return false;
  }
}

/**
 * Converts a BigNumber to a FixedNumber of the format fixed128x18.
 * @param big The BigNumber to convert.
 * @returns A FixedNumber representation of a BigNumber.
 */
export function bigToFixed(big: BigNumber.Value): FixedNumber {
  return FixedNumber.from(big.toString(10));
}

/**
 * Converts a FixedNumber (of any format) to a BigNumber.
 * @param fixed The FixedNumber to convert.
 * @param ceil If true, the ceiling of fixed is used. Otherwise, the floor is used.
 * @returns A BigNumber representation of a FixedNumber.
 */
export function fixedToBig(fixed: FixedNumber, ceil = false): BigNumber {
  const fixedAsInteger = ceil ? fixed.ceiling() : fixed.floor();
  return BigNumber(fixedAsInteger.toFormat('fixed256x0').toString());
}

/**
 * Multiplies a BigNumber by a FixedNumber, returning the BigNumber product.
 * @param big The BigNumber to multiply.
 * @param fixed The FixedNumber to multiply.
 * @param ceil If true, the ceiling of the product is used. Otherwise, the floor is used.
 * @returns The BigNumber product in string type.
 */
export function mulBigAndFixed(
  big: BigNumber.Value,
  fixed: FixedNumber,
  ceil = false,
): string {
  // Converts big to a FixedNumber, multiplies it by fixed, and converts the product back
  // to a BigNumber.
  return fixedToBig(fixed.mulUnsafe(bigToFixed(big)), ceil).toString(10);
}

/**
 * Return the smaller in the given two BigNumbers.
 * @param bn1 The BigNumber to compare.
 * @param bn2 The BigNumber to compare.
 * @returns The smaller BigNumber in string type.
 */
export function BigNumberMin(
  bn1: BigNumber.Value,
  bn2: BigNumber.Value,
): string {
  return BigNumber(bn1).gte(bn2) ? bn2.toString(10) : bn1.toString(10);
}

/**
 * Return the bigger in the given two BigNumbers.
 * @param bn1 The BigNumber to compare.
 * @param bn2 The BigNumber to compare.
 * @returns The bigger BigNumber in string type.
 */
export function BigNumberMax(
  bn1: BigNumber.Value,
  bn2: BigNumber.Value,
): string {
  return BigNumber(bn1).lte(bn2) ? bn2.toString(10) : bn1.toString(10);
}
