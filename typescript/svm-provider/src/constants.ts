import type { Address } from '@solana/kit';

export const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

export const SYSTEM_PROGRAM_ADDRESS =
  '11111111111111111111111111111111' as Address;

export const RENT_SYSVAR_ADDRESS =
  'SysvarRent111111111111111111111111111111111' as Address;

export const CLOCK_SYSVAR_ADDRESS =
  'SysvarC1ock11111111111111111111111111111111' as Address;
// Kept as literals to avoid adding a direct '@solana/sysvars' dependency here.

export const SPL_NOOP_PROGRAM_ADDRESS =
  'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV' as Address;

export const LOADER_V3_PROGRAM_ADDRESS =
  'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

export const SPL_TOKEN_PROGRAM_ADDRESS =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

export const TOKEN_2022_PROGRAM_ADDRESS =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;

export const METAPLEX_METADATA_PROGRAM_ADDRESS =
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' as Address;
