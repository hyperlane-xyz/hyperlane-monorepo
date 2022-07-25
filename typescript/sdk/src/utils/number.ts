import { BigNumber, FixedNumber } from 'ethers';

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
  return BigNumber.from(fixedAsInteger.toFormat('fixed256x0').toString());
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

/**
 * Converts a value with `fromDecimals` decimals to a value with `toDecimals` decimals.
 * Incurs a loss of precision when `fromDecimals` > `toDecimals`.
 * @param value The value to convert.
 * @param fromDecimals The number of decimals `value` has.
 * @param toDecimals The number of decimals to convert `value` to.
 * @returns `value` represented with `toDecimals` decimals.
 */
export function convertDecimalValue(
  value: BigNumber,
  fromDecimals: number,
  toDecimals: number,
): BigNumber {
  if (fromDecimals === toDecimals) {
    return value;
  } else if (fromDecimals > toDecimals) {
    return value.div(10 ** (fromDecimals - toDecimals));
  } else {
    // if (fromDecimals < toDecimals)
    return value.mul(10 ** (toDecimals - fromDecimals));
  }
}
