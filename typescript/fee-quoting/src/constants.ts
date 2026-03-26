import type { Address, Hex } from 'viem';

export const DEFAULT_PORT = 8080;
export const DEFAULT_METRICS_PORT = 9090;
export const DEFAULT_QUOTE_EXPIRY_SECONDS = 3600;

export const ZERO_ADDRESS =
  '0x0000000000000000000000000000000000000000' as Address;
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

/**
 * EIP-712 domain (without chainId/verifyingContract — added per-sign).
 * Matches AbstractOffchainQuoter.sol: _NAME_HASH = keccak256("OffchainQuoter"), _VERSION_HASH = keccak256("1")
 */
export const EIP712_DOMAIN = {
  name: 'OffchainQuoter',
  version: '1',
} as const;

/**
 * EIP-712 types for SignedQuote struct.
 * Matches AbstractOffchainQuoter.sol SIGNED_QUOTE_TYPEHASH:
 *   "SignedQuote(bytes context,bytes data,uint48 issuedAt,uint48 expiry,bytes32 salt,address submitter)"
 */
export const SIGNED_QUOTE_TYPES = {
  SignedQuote: [
    { name: 'context', type: 'bytes' },
    { name: 'data', type: 'bytes' },
    { name: 'issuedAt', type: 'uint48' },
    { name: 'expiry', type: 'uint48' },
    { name: 'salt', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
  ],
} as const;
