/**
 * The types defined here are the source of truth for chain metadata.
 * ANY CHANGES HERE NEED TO BE REFLECTED IN HYPERLANE-BASE CONFIG PARSING.
 */
import { z } from 'zod';

/**
 * Creates a forward-compatible Zod schema for enums that normalizes unknown values.
 *
 * When registry is updated with new enum values, older SDK versions will parse
 * the unknown value as the specified `unknownValue` instead of failing entirely.
 *
 * This enables:
 * - Old SDK + New Registry: Works - unknown values become `Unknown` variant
 * - New SDK + Old Registry: Works - known values parse normally
 * - TypeScript exhaustiveness checking forces explicit handling of unknown cases
 *
 * @param enumObj - The enum or const object to validate against
 * @param unknownValue - The value to use for unknown/new enum variants
 * @returns A Zod schema that accepts any string but normalizes unknown values
 *
 * @example
 * ```ts
 * const zProtocolType = forwardCompatibleEnum(ProtocolType, ProtocolType.Unknown);
 * zProtocolType.parse('ethereum'); // => ProtocolType.Ethereum
 * zProtocolType.parse('newprotocol'); // => ProtocolType.Unknown
 * ```
 */
export function forwardCompatibleEnum<T extends Record<string, string>>(
  enumObj: T,
  unknownValue: T[keyof T],
): z.ZodEffects<z.ZodUnion<[z.ZodNativeEnum<T>, z.ZodString]>, T[keyof T]> {
  const validValues = Object.values(enumObj) as T[keyof T][];
  return z
    .nativeEnum(enumObj)
    .or(z.string())
    .transform((val): T[keyof T] => {
      return validValues.includes(val as T[keyof T])
        ? (val as T[keyof T])
        : unknownValue;
    });
}

/** Zod uint schema */
export const ZUint = z.number().int().nonnegative();
/** Zod NonZeroUint schema */
export const ZNzUint = z.number().int().positive();
/** Zod unsigned Wei schema which accepts either a string number or a literal number */
export const ZUWei = z.union([ZUint.safe(), z.string().regex(/^\d+$/)]);
/** Zod 128, 160, 256, or 512 bit hex-defined hash with a 0x prefix for hex and no prefix for base58 */
export const ZHash = z
  .string()
  .regex(
    /^(0x([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{128}))|([123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32})|([a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,58})|^(account|component)_(rdx|sim|tdx_[\d]_)[a-z0-9]{55}|^[a-z0-9_]+\.aleo\/aleo1[a-z0-9]{58}$/,
  );
/** Zod ChainName schema */
export const ZChainName = z.string().regex(/^[a-z][a-z0-9]*$/);

export const ZBigNumberish = z
  .bigint()
  .or(ZUint)
  .or(z.string().regex(/^[0-9]+$/))
  .transform(BigInt);

export const ZBytes32String = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{64}$/,
    'Must be a 0x prefixed 64-character hexadecimal string (32 bytes)',
  )
  .transform((val) => val.toLowerCase());
