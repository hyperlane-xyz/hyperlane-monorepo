import { BigNumber } from 'bignumber.js';

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

/**
 * Converts a value to a bignumber.js BigNumber fixed-point representation.
 * @param big The BigNumber to convert.
 * @returns A bignumber.js BigNumber representation.
 */
export function bigToFixed(big: BigNumber.Value): BigNumber {
  return BigNumber(big);
}

/**
 * Converts a fixed-point value to a BigNumber integer.
 * @param fixed The fixed-point number to convert.
 * @param ceil If true, the ceiling of fixed is used. Otherwise, the floor is used.
 * @returns A BigNumber representation of a FixedNumber.
 */
export function fixedToBig(
  fixed: BigNumber.Value,
  ceil = false,
): BigNumber {
  return BigNumber(fixed).integerValue(
    ceil ? BigNumber.ROUND_CEIL : BigNumber.ROUND_FLOOR,
  );
}

/**
 * Multiplies a BigNumber by a fixed-point value, returning the BigNumber product.
 * @param big The BigNumber to multiply.
 * @param fixed The fixed-point value to multiply.
 * @param ceil If true, the ceiling of the product is used. Otherwise, the floor is used.
 * @returns The BigNumber product in string type.
 */
export function mulBigAndFixed(
  big: BigNumber.Value,
  fixed: BigNumber.Value,
  ceil = false,
): string {
  return fixedToBig(BigNumber(big).times(fixed), ceil).toString(10);
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

export type BigIntLike = { toBigInt(): bigint };
export type Stringable = { toString(): string };

export type BigIntCoercible =
  | bigint
  | number
  | string
  | BigIntLike
  | Stringable;

function isBigIntLike(value: unknown): value is BigIntLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { toBigInt?: unknown }).toBigInt === 'function'
  );
}

function isStringable(value: unknown): value is Stringable {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { toString?: unknown }).toString === 'function'
  );
}

export function isBigIntCoercible(value: unknown): value is BigIntCoercible {
  if (
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return true;
  }

  if (isBigIntLike(value) || isStringable(value)) return true;

  return false;
}

/**
 * Converts a value to bigint.
 * @param value The value to convert.
 * @param errorMessage Optional error message when conversion fails.
 * @returns bigint representation of the value.
 */
export function toBigInt(value: BigIntCoercible, errorMessage?: string): bigint;
export function toBigInt(value: unknown, errorMessage?: string): bigint;
export function toBigInt(
  value: unknown,
  errorMessage = 'Unable to convert value to bigint',
): bigint {
  try {
    if (typeof value === 'bigint') return value;

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`Invalid number: ${value}`);
      }
      return BigInt(value);
    }

    if (typeof value === 'string') return BigInt(value);

    if (isBigIntLike(value)) return value.toBigInt();
    if (isStringable(value)) return BigInt(value.toString());
  } catch (error) {
    const cause =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : String(error);
    throw new Error(`${errorMessage}: ${cause}`);
  }

  throw new Error(errorMessage);
}
