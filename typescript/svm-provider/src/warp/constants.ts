import type { Address, ReadonlyUint8Array } from '@solana/kit';

/**
 * Program instruction discriminator used by all Hyperlane token programs.
 * From Rust: PROGRAM_INSTRUCTION_DISCRIMINATOR = [1,1,1,1,1,1,1,1]
 */
export const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

/** Native SOL decimal precision. */
export const SOL_DECIMALS = 9;

/**
 * Prepends the 8-byte Hyperlane token program discriminator to encoded instruction data.
 */
export function prependDiscriminator(
  encodedArgs: ReadonlyUint8Array,
): Uint8Array {
  const data = new Uint8Array(8 + encodedArgs.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(encodedArgs, 8);
  return data;
}
