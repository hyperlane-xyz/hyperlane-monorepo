import { assert } from '@hyperlane-xyz/utils';

/**
 * Converts a numeric value coming from an RPC or a block explorer to a number.
 *
 * The same field is returned as a JSON number by some providers, as a decimal
 * string by others and as a hex string by the rest, so all three forms are
 * accepted and validated against the safe integer range.
 */
export function toNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    assert(
      Number.isSafeInteger(value),
      `${field} is not a safe integer: ${value}`,
    );
    return value;
  }

  if (typeof value === 'bigint') {
    const num = Number(value);
    assert(
      Number.isFinite(num) && BigInt(num) === value,
      `${field} bigint value ${value} exceeds safe integer range`,
    );
    return num;
  }

  if (typeof value === 'string') {
    assert(
      /^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value),
      `${field} string "${value}" is not a valid hex or decimal number`,
    );
    const num = value.startsWith('0x')
      ? parseInt(value, 16)
      : parseInt(value, 10);
    assert(!Number.isNaN(num), `${field} parsed to NaN from "${value}"`);
    assert(
      Number.isSafeInteger(num),
      `${field} string value "${value}" exceeds safe integer range`,
    );
    return num;
  }

  assert(false, `Unable to convert ${field} to number`);
}
