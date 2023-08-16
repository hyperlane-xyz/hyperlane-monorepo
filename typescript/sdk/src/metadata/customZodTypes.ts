import { z } from 'zod';

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
    /^(0x[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{128})|([123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32})$/,
  );
