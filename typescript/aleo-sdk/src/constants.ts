export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';
export const ALEO_NATIVE_DENOM = 'credits';

// CAST: Preserve literal IDs so AleoNetworkId remains the 0 | 1 union.
export const AleoNetworkId = {
  MAINNET: 0,
  TESTNET: 1,
} as const;

export type AleoNetworkId = (typeof AleoNetworkId)[keyof typeof AleoNetworkId];
