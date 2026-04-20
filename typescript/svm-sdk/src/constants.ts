import { address as castAddress, type Address } from '@solana/kit';

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

// Solana hard limit on account data size.
export const MAX_ACCOUNT_DATA_SIZE = 10_485_760;

// Fixed base fee per signature on Solana.
// https://solana.com/docs/core/fees#base-fee
export const LAMPORTS_PER_SIGNATURE = 5_000;

// https://spl.solana.com/token
export const SPL_TOKEN_PROGRAM_ADDRESS =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

// https://spl.solana.com/token-2022
export const TOKEN_2022_PROGRAM_ADDRESS =
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;

// https://github.com/metaplex-foundation/mpl-token-metadata/blob/c314930196b6b16e1ba8fefdf206e9af7b0e4c37/programs/token-metadata/program/src/lib.rs#L25
export const METAPLEX_METADATA_PROGRAM_ADDRESS =
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' as Address;

// Hand-rolled to avoid adding @solana-program/compute-budget as a dependency.
export const COMPUTE_BUDGET_PROGRAM_ID = castAddress(
  'ComputeBudget111111111111111111111111111111',
);

// Default compute unit budget for SVM deployment transactions.
export const DEFAULT_COMPUTE_UNITS = 400_000;
