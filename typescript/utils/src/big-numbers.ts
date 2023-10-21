import BigNumber from 'bignumber.js';
import { FixedNumber } from 'ethers';

export function isBigNumberish(
  value: string | number | BigNumber | undefined,
): boolean {
  try {
    const val = BigNumber(value!);
    return !val.isNaN() && val.isFinite() && BigNumber.isBigNumber(val);
  } catch (error) {
    return false;
  }
}

// If a value (e.g. hex string or number) is zeroish (0, 0x0, 0x00, etc.)
export function isZeroish(value: string | number | BigNumber): boolean {
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
export function bigToFixed(big: BigNumber): FixedNumber {
  return FixedNumber.from(big.toString());
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
 * @returns The BigNumber product.
 */
export function mulBigAndFixed(
  big: BigNumber,
  fixed: FixedNumber,
  ceil = false,
): BigNumber {
  // Converts big to a FixedNumber, multiplies it by fixed, and converts the product back
  // to a BigNumber.
  return fixedToBig(fixed.mulUnsafe(bigToFixed(big)), ceil);
}

export function BigNumberMin(bn1: BigNumber, bn2: BigNumber) {
  return bn1.gte(bn2) ? bn2 : bn1;
}
export function BigNumberMax(bn1: BigNumber, bn2: BigNumber) {
  return bn1.lte(bn2) ? bn2 : bn1;
}
