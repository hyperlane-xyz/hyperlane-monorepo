import type { Address, Hex } from 'viem';

export const DEFAULT_PORT = 8080;
export const DEFAULT_METRICS_PORT = 9090;
export const DEFAULT_QUOTE_EXPIRY_SECONDS = 3600;

/**
 * On-chain quote-verifier rejects a transient quote whose `issued_at` exceeds
 * `clock + this skew` (`MAX_QUOTE_ISSUED_AT_FUTURE_SKEW_SECS` in the SVM
 * quote-verifier). Transient quotes forward-date `issued_at = now + buffer`, so
 * the buffer must stay strictly below this to leave headroom for clock lag
 * between the server's sign time and the on-chain consume time.
 */
export const ONCHAIN_MAX_ISSUED_AT_FUTURE_SKEW_SECONDS = 300;
/** Transient forward-date buffer; below the on-chain cap to absorb clock lag. */
export const DEFAULT_TRANSIENT_BUFFER_SECONDS = 240;

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
