import { formatUnits, parseUnits } from '@ethersproject/units';
import BigNumber from 'bignumber.js';
import { ethers } from 'ethers';

const DEFAULT_MIN_ROUNDED_VALUE = 0.00001;
const DEFAULT_DISPLAY_DECIMALS = 4;
const DEFAULT_TOKEN_DECIMALS = 18;

type NumberT = BigNumber.Value;

export function fromWei(
  value: NumberT | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
): number {
  if (!value) return 0;
  const valueString = value.toString().trim();
  const flooredValue = new BigNumber(valueString).toFixed(
    0,
    BigNumber.ROUND_FLOOR,
  );
  return parseFloat(formatUnits(flooredValue, decimals));
}

// Similar to fromWei above but rounds to set number of decimals
// with a minimum floor, configured per token
export function fromWeiRounded(
  value: NumberT | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
  roundDownIfSmall = true,
): string {
  if (!value) return '0';
  const flooredValue = new BigNumber(value).toFixed(0, BigNumber.ROUND_FLOOR);
  const amount = new BigNumber(formatUnits(flooredValue, decimals));
  if (amount.isZero()) return '0';

  // If amount is less than min value
  if (amount.lt(DEFAULT_MIN_ROUNDED_VALUE)) {
    if (roundDownIfSmall) return '0';
    return amount.toString(10);
  }

  const displayDecimals = amount.gte(10000) ? 2 : DEFAULT_DISPLAY_DECIMALS;
  return amount.toFixed(displayDecimals).toString();
}

export function toWei(
  value: NumberT | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
): BigNumber {
  if (!value) return new BigNumber(0);
  // First convert to a BigNumber, and then call `toString` with the
  // explicit radix 10 such that the result is formatted as a base-10 string
  // and not in scientific notation.
  const valueBN = new BigNumber(value);
  const valueString = valueBN.toString(10).trim();
  const components = valueString.split('.');
  if (components.length === 1) {
    return new BigNumber(parseUnits(valueString, decimals).toString());
  } else if (components.length === 2) {
    const trimmedFraction = components[1].substring(0, decimals);
    return new BigNumber(
      parseUnits(`${components[0]}.${trimmedFraction}`, decimals).toString(),
    );
  } else {
    throw new Error(`Cannot convert ${valueString} to wei`);
  }
}

export function tryParseAmount(
  value: NumberT | null | undefined,
): BigNumber | null {
  try {
    if (!value) return null;
    const parsed = new BigNumber(value);
    if (!parsed || parsed.isNaN() || !parsed.isFinite()) return null;
    else return parsed;
  } catch (error) {
    return null;
  }
}

// Checks if an amount is equal of nearly equal to balance within a small margin of error
// Necessary because amounts in the UI are often rounded
export function eqAmountApproximate(
  amountInWei1: BigNumber,
  amountInWei2: NumberT,
) {
  const minValueWei = toWei(DEFAULT_MIN_ROUNDED_VALUE);
  // Is difference btwn amount and balance less than min amount shown for token
  return amountInWei1.minus(amountInWei2).abs().lt(minValueWei);
}

/**
 * Converts a value with `fromDecimals` decimals to a value with `toDecimals` decimals.
 * Incurs a loss of precision when `fromDecimals` > `toDecimals`.
 * @param fromDecimals The number of decimals `value` has.
 * @param toDecimals The number of decimals to convert `value` to.
 * @param value The value to convert.
 * @returns `value` represented with `toDecimals` decimals.
 */
export function convertDecimals(
  fromDecimals: number,
  toDecimals: number,
  value: NumberT,
) {
  const amount = new BigNumber(value);

  if (fromDecimals === toDecimals) return amount;
  else if (fromDecimals > toDecimals) {
    const difference = fromDecimals - toDecimals;
    return amount
      .div(new BigNumber(10).pow(difference))
      .integerValue(BigNumber.ROUND_FLOOR);
  }
  // fromDecimals < toDecimals
  else {
    const difference = toDecimals - fromDecimals;
    return amount.times(new BigNumber(10).pow(difference));
  }
}

/**
 * Converts a value with `fromDecimals` decimals to a value with `toDecimals` decimals.
 * Incurs a loss of precision when `fromDecimals` > `toDecimals`.
 * @param fromDecimals The number of decimals `value` has.
 * @param toDecimals The number of decimals to convert `value` to.
 * @param value The value to convert.
 * @returns `value` represented with `toDecimals` decimals.
 */
export function convertDecimalsEthersBigNumber(
  fromDecimals: number,
  toDecimals: number,
  value: ethers.BigNumber,
) {
  if (fromDecimals === toDecimals) return value;
  else if (fromDecimals > toDecimals) {
    const difference = fromDecimals - toDecimals;
    return value.div(ethers.BigNumber.from('10').pow(difference));
  }
  // fromDecimals < toDecimals
  else {
    const difference = toDecimals - fromDecimals;
    return value.mul(ethers.BigNumber.from('10').pow(difference));
  }
}
