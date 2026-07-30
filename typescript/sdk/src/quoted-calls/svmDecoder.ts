import { hexToBytes } from 'viem';

import type { SealevelQuoteV2Entry, SealevelSignedQuote } from './types.js';

/**
 * Byte layout of `SvmSignedQuote` on-chain. Mirrors
 * `@hyperlane-xyz/sealevel-sdk`'s `SvmSignedQuote` Borsh struct without
 * importing from svm-sdk (per `[no-svm-sdk-dep-in-main-sdk]`).
 *
 * - `context`: 44 bytes (non-CC) or 76 bytes (CC) — variable.
 * - `data`: Borsh-encoded `FeeDataStrategy` — variable, max ~32 bytes.
 * - `issuedAt`: 6 bytes (u48 BE unix seconds).
 * - `expiry`: 6 bytes (u48 BE unix seconds). `expiry === issuedAt` ⇒ transient.
 * - `clientSalt`: 32 bytes.
 * - `signature`: 65 bytes (r:32, s:32, v:1).
 */
export interface DecodedSvmSignedQuote {
  context: Uint8Array;
  data: Uint8Array;
  issuedAt: Uint8Array;
  expiry: Uint8Array;
  clientSalt: Uint8Array;
  signature: Uint8Array;
}

/**
 * Decoded form of a `SealevelQuoteV2Entry` ready for instruction-builder
 * consumption. All hex byte fields from the wire shape are converted to
 * `Uint8Array`; the integer / string envelope fields are passed through.
 *
 * Kept structurally identical to what svm-sdk's `getSubmitQuoteInstruction`
 * expects so callers can duck-type at the boundary — sdk can't import
 * svm-sdk's `SvmSignedQuote` type directly.
 */
export interface DecodedSealevelQuoteEntry {
  /** Fee/IGP program account pubkey (base58 string from the envelope). */
  quoter: string;
  /** Origin domain id (decoded from envelope). */
  domainId: number;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. `expiry === issuedAt` ⇒ transient quote. */
  expiry: number;
  /** Byte-decoded `SvmSignedQuote`. */
  signedQuote: DecodedSvmSignedQuote;
}

/**
 * Convert the wire `SealevelQuoteV2Entry` (hex byte fields) into a
 * `DecodedSealevelQuoteEntry` whose `signedQuote` fields are `Uint8Array`s.
 *
 * Pure transport-layer decode — no signature checking, no semantic
 * validation. Validation happens on-chain when the quote is consumed.
 */
export function decodeSealevelQuoteEntry(
  entry: SealevelQuoteV2Entry,
): DecodedSealevelQuoteEntry {
  const signed: SealevelSignedQuote = entry.details.signedQuote;
  return {
    quoter: entry.quoter,
    domainId: entry.details.domainId,
    issuedAt: entry.issuedAt,
    expiry: entry.expiry,
    signedQuote: {
      context: hexToBytes(signed.context),
      data: hexToBytes(signed.data),
      issuedAt: hexToBytes(signed.issuedAt),
      expiry: hexToBytes(signed.expiry),
      clientSalt: hexToBytes(signed.clientSalt),
      signature: hexToBytes(signed.signature),
    },
  };
}
