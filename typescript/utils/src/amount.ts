import { formatUnits, parseUnits } from '@ethersproject/units';
import { BigNumber } from 'bignumber.js';
import { ethers } from 'ethers';

const DEFAULT_DISPLAY_DECIMALS = 4;
const DEFAULT_TOKEN_DECIMALS = 18;

/**
 * Convert the given Wei value to Ether value
 * @param value The value to convert.
 * @returns Converted value in string type.
 */
export function fromWei(
  value: BigNumber.Value | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
): string {
  if (!value) return (0).toString();
  const valueString = value.toString(10).trim();
  const flooredValue = BigNumber(valueString).toFixed(0, BigNumber.ROUND_FLOOR);
  return parseFloat(formatUnits(flooredValue, decimals)).toString();
}

/**
 * Convert the given Wei value to Ether value,
 * round to set number of decimals with a minimum floor, configured per token
 * @param value The value to convert.
 * @param decimals
 * @returns Converted value in string type.
 */
export function fromWeiRounded(
  value: BigNumber.Value | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
  displayDecimals?: number,
): string {
  if (!value) return '0';
  const flooredValue = BigNumber(value).toFixed(0, BigNumber.ROUND_FLOOR);
  const amount = BigNumber(formatUnits(flooredValue, decimals));
  if (amount.isZero()) return '0';
  displayDecimals ??= amount.gte(10000) ? 2 : DEFAULT_DISPLAY_DECIMALS;
  return amount.toFixed(displayDecimals, BigNumber.ROUND_FLOOR);
}

/**
 * Convert the given value to Wei value
 * @param value The value to convert.
 * @returns Converted value in string type.
 */
export function toWei(
  value: BigNumber.Value | null | undefined,
  decimals = DEFAULT_TOKEN_DECIMALS,
): string {
  if (!value) return BigNumber(0).toString();
  // First convert to a BigNumber, and then call `toString` with the
  // explicit radix 10 such that the result is formatted as a base-10 string
  // and not in scientific notation.
  const valueBN = BigNumber(value);
  const valueString = valueBN.toString(10).trim();
  const components = valueString.split('.');
  if (components.length === 1) {
    return parseUnits(valueString, decimals).toString();
  } else if (components.length === 2) {
    const trimmedFraction = components[1].substring(0, decimals);
    return parseUnits(
      `${components[0]}.${trimmedFraction}`,
      decimals,
    ).toString();
  } else {
    throw new Error(`Cannot convert ${valueString} to wei`);
  }
}

/**
 * Try to parse the given value into BigNumber.js BigNumber
 * @param value The value to parse.
 * @returns Parsed value in BigNumber.js BigNumber type.
 */
export function tryParseAmount(
  value: BigNumber.Value | null | undefined,
): BigNumber | null {
  try {
    if (!value) return null;
    const parsed = BigNumber(value);
    if (!parsed || parsed.isNaN() || !parsed.isFinite()) return null;
    else return parsed;
  } catch {
    return null;
  }
}

/**
 * Checks if an amount is equal of nearly equal to balance within a small margin of error
 * Necessary because amounts in the UI are often rounded
 * @param amount1 The amount to compare.
 * @param amount2 The amount to compare.
 * @returns true/false.
 */
export function eqAmountApproximate(
  amount1: BigNumber.Value,
  amount2: BigNumber.Value,
  maxDifference: BigNumber.Value,
): boolean {
  // Is difference btwn amounts less than maxDifference
  return BigNumber(amount1).minus(amount2).abs().lte(maxDifference);
}

/**
 * Converts a value with `fromDecimals` decimals to a value with `toDecimals` decimals.
 * Incurs a loss of precision when `fromDecimals` > `toDecimals`.
 * @param fromDecimals The number of decimals `value` has.
 * @param toDecimals The number of decimals to convert `value` to.
 * @param value The value to convert.
 * @returns `value` represented with `toDecimals` decimals in string type.
 */
export function convertDecimalsToIntegerString(
  fromDecimals: number,
  toDecimals: number,
  value: BigNumber.Value,
): string {
  const converted = convertDecimals(fromDecimals, toDecimals, value);
  return converted.integerValue(BigNumber.ROUND_FLOOR).toString(10);
}

export function convertDecimals(
  fromDecimals: number,
  toDecimals: number,
  value: BigNumber.Value,
): BigNumber {
  const amount = BigNumber(value);

  if (fromDecimals === toDecimals) return amount;
  else if (fromDecimals > toDecimals) {
    const difference = fromDecimals - toDecimals;
    return amount.div(BigNumber(10).pow(difference));
  }
  // fromDecimals < toDecimals
  else {
    const difference = toDecimals - fromDecimals;
    return amount.times(BigNumber(10).pow(difference));
  }
}

// Default gas limit buffer percentage
const DEFAULT_GAS_LIMIT_BUFFER_PERCENT = 10;

/**
 * Calculates the gas limit with a buffer added to the estimated gas.
 * @param estimatedGas The estimated gas for the transaction.
 * @param bufferPercent The percentage to add as a buffer (default: 10%).
 * @returns The calculated gas limit with the buffer added.
 */
export function addBufferToGasLimit(
  estimatedGas: ethers.BigNumber,
  bufferPercent: number = DEFAULT_GAS_LIMIT_BUFFER_PERCENT,
): ethers.BigNumber {
  const bufferMultiplier = 100 + bufferPercent;
  return estimatedGas.mul(bufferMultiplier).div(100);
}
