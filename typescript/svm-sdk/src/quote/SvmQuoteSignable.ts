import { assert } from '@hyperlane-xyz/utils';

/**
 * Cross-VM `SignableInput` shape for the SVM warp quote signer.
 *
 * Carries the semantic inputs the SVM `quote-verifier` digest is built from:
 * `feeAccount`, `domainId`, packed `context` / `data` bytes, `issuedAt` /
 * `expiry` (unix seconds), and the pre-computed `scopedSalt`. The signer
 * impl narrows the opaque envelope via `parseSvmQuoteSignable`, then builds
 * the keccak256 digest and signs it with secp256k1 — analogous to how the
 * EVM signer narrows EIP-712 typed-data and builds the typed-data hash
 * internally.
 */

const SCOPED_SALT_LEN = 32;

export type SvmQuoteSignable = {
  /** Solana address (base58) of the fee account / IGP account the quote applies to. */
  feeAccount: string;
  /** Hyperlane domain ID of the chain this quote is for. */
  domainId: number;
  /** Packed quote context (44 B for Leaf/Routing, 76 B for cross-collateral). */
  context: Uint8Array;
  /** Packed quote data (Borsh-encoded `FeeDataStrategy` or equivalent). */
  data: Uint8Array;
  /** Unix-seconds; encoded as u48 BE in the digest. */
  issuedAt: number;
  /** Unix-seconds; `expiry === issuedAt` ⇒ transient. */
  expiry: number;
  /** `keccak256(payer || clientSalt)` — pre-computed by the writer. */
  scopedSalt: Uint8Array;
};

export function isSvmQuoteSignable(input: unknown): input is SvmQuoteSignable {
  if (typeof input !== 'object' || input === null) return false;
  const o = input as Record<string, unknown>;
  return (
    typeof o.feeAccount === 'string' &&
    typeof o.domainId === 'number' &&
    o.context instanceof Uint8Array &&
    o.data instanceof Uint8Array &&
    typeof o.issuedAt === 'number' &&
    typeof o.expiry === 'number' &&
    o.scopedSalt instanceof Uint8Array &&
    o.scopedSalt.length === SCOPED_SALT_LEN
  );
}

export function parseSvmQuoteSignable(input: unknown): SvmQuoteSignable {
  assert(
    isSvmQuoteSignable(input),
    'Expected SVM quote signable envelope: { feeAccount, domainId, context, data, issuedAt, expiry, scopedSalt }.',
  );
  return input;
}
