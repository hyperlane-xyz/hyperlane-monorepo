import { type Hex, isHex } from 'viem';
import { z } from 'zod';

// Bytes32 schema narrows to viem's branded `Hex`. Used for fixed-32-byte
// fields (salt, recipient, targetRouter) regardless of origin protocol.
export const bytes32Schema = z.custom<Hex>(
  (v): boolean =>
    typeof v === 'string' && isHex(v, { strict: true }) && v.length === 66,
  'Invalid bytes32 hex (must be 0x + 64 hex chars)',
);

export const domainSchema = z
  .string()
  .regex(/^\d+$/, 'Domain must be a numeric string')
  .transform((s) => parseInt(s, 10));
