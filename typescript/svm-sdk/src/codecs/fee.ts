import type { ReadonlyUint8Array } from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import {
  FeeDataKind,
  type FeeStrategyKind,
  h160ToSigner,
  signerToH160,
} from '../fee/types.js';

import {
  type ByteCursor,
  concatBytes,
  ensureLength,
  option,
  u8,
  u32le,
  u64le,
  vecBytes,
} from './binary.js';

// ====== Discriminators (8-byte ASCII) ======

export const FEE_ACCT_DISCRIMINATOR = new Uint8Array([
  0x46,
  0x45,
  0x45,
  0x5f,
  0x41,
  0x43,
  0x43,
  0x54, // FEE_ACCT
]);

// ====== Fee Params ======

export interface SvmFeeParams {
  maxFee: bigint;
  halfAmount: bigint;
}

export function encodeFeeParams(params: SvmFeeParams): ReadonlyUint8Array {
  return concatBytes(u64le(params.maxFee), u64le(params.halfAmount));
}

// ====== Fee Data Strategy ======

export type SvmFeeDataStrategy =
  | { kind: typeof FeeStrategyKind.Linear; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Regressive; params: SvmFeeParams }
  | { kind: typeof FeeStrategyKind.Progressive; params: SvmFeeParams };

export function encodeFeeDataStrategy(
  strategy: SvmFeeDataStrategy,
): ReadonlyUint8Array {
  return concatBytes(u8(strategy.kind), encodeFeeParams(strategy.params));
}

// ====== BTreeSet<H160> encoding ======

/**
 * Encodes a list of H160 signers as a Borsh BTreeSet.
 * Sorts lexicographically to match Rust BTreeSet canonical order.
 */
export function encodeBTreeSetH160(signers: string[]): ReadonlyUint8Array {
  const unique = [...new Set(signers.map((s) => s.toLowerCase()))];
  const bytes = unique.map(signerToH160);
  const sorted = bytes.sort((a, b) => {
    for (let i = 0; i < 20; i++) {
      const diff = a[i] - b[i];
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return concatBytes(u32le(sorted.length), ...sorted);
}

/**
 * Decodes a Borsh `BTreeSet<H160>` from the cursor.
 * Mirror of `encodeBTreeSetH160`. Returns 0x-prefixed lowercase hex strings.
 */
export function decodeBTreeSetH160(cursor: ByteCursor): string[] {
  const count = cursor.readU32LE();
  const signers: string[] = [];
  for (let i = 0; i < count; i += 1) {
    signers.push(h160ToSigner(cursor.readBytes(20)));
  }
  return signers;
}

// ====== SvmSignedQuote (shared with IGP) ======

const SVM_SIGNED_QUOTE_ISSUED_AT_LEN = 6;
const SVM_SIGNED_QUOTE_EXPIRY_LEN = 6;
const SVM_SIGNED_QUOTE_CLIENT_SALT_LEN = 32;
const SVM_SIGNED_QUOTE_SIGNATURE_LEN = 65;

/**
 * A signed offchain quote — secp256k1 ECDSA signature over
 * (context || data || issuedAt || expiry || clientSalt). Mirrors the
 * Rust `SvmSignedQuote` in the quote-verifier library, used by both
 * the fee program (SubmitQuote) and the IGP (SubmitIgpQuote).
 *
 * `expiry === issuedAt` ⇒ transient quote (single-tx).
 * `expiry  >  issuedAt` ⇒ standing quote (long-lived).
 */
export interface SvmSignedQuote {
  context: Uint8Array;
  data: Uint8Array;
  /** 6 bytes (u48 BE). */
  issuedAt: Uint8Array;
  /** 6 bytes (u48 BE). */
  expiry: Uint8Array;
  /** 32 bytes — client-provided salt for PDA derivation + replay prevention. */
  clientSalt: Uint8Array;
  /** 65 bytes (r:32, s:32, v:1). */
  signature: Uint8Array;
}

export function encodeSvmSignedQuote(quote: SvmSignedQuote): Uint8Array {
  ensureLength(quote.issuedAt, SVM_SIGNED_QUOTE_ISSUED_AT_LEN, 'issuedAt');
  ensureLength(quote.expiry, SVM_SIGNED_QUOTE_EXPIRY_LEN, 'expiry');
  ensureLength(
    quote.clientSalt,
    SVM_SIGNED_QUOTE_CLIENT_SALT_LEN,
    'clientSalt',
  );
  ensureLength(quote.signature, SVM_SIGNED_QUOTE_SIGNATURE_LEN, 'signature');
  return Uint8Array.from(
    concatBytes(
      vecBytes(quote.context),
      vecBytes(quote.data),
      quote.issuedAt,
      quote.expiry,
      quote.clientSalt,
      quote.signature,
    ),
  );
}

export function decodeSvmSignedQuote(cursor: ByteCursor): SvmSignedQuote {
  return {
    context: cursor.readVecBytes(),
    data: cursor.readVecBytes(),
    issuedAt: cursor.readBytes(SVM_SIGNED_QUOTE_ISSUED_AT_LEN),
    expiry: cursor.readBytes(SVM_SIGNED_QUOTE_EXPIRY_LEN),
    clientSalt: cursor.readBytes(SVM_SIGNED_QUOTE_CLIENT_SALT_LEN),
    signature: cursor.readBytes(SVM_SIGNED_QUOTE_SIGNATURE_LEN),
  };
}

// ====== SetQuoteSigner operation ======

export const SetQuoteSignerOp = {
  Add: 0,
  Remove: 1,
} as const;

export type SetQuoteSignerOp =
  (typeof SetQuoteSignerOp)[keyof typeof SetQuoteSignerOp];

export function encodeSetQuoteSignerOperation(
  op: SetQuoteSignerOp,
  signer: string,
): ReadonlyUint8Array {
  return concatBytes(u8(op), signerToH160(signer));
}

/**
 * Decodes a `(op, H160)` pair encoded by `encodeSetQuoteSignerOperation`.
 * Returns the op kind and 0x-prefixed lowercase hex signer.
 */
export function decodeSetQuoteSignerOperation(cursor: ByteCursor): {
  operation: SetQuoteSignerOp;
  signer: string;
} {
  const op = cursor.readU8();
  if (op !== SetQuoteSignerOp.Add && op !== SetQuoteSignerOp.Remove) {
    throw new Error(`Invalid SetQuoteSignerOp: ${op}`);
  }
  const signer = h160ToSigner(cursor.readBytes(20));
  return { operation: op, signer };
}

// ====== Leaf Fee Config ======

export interface SvmLeafFeeConfig {
  strategy: SvmFeeDataStrategy;
  signers: string[] | null;
}

export function encodeLeafFeeConfig(
  config: SvmLeafFeeConfig,
): ReadonlyUint8Array {
  return concatBytes(
    encodeFeeDataStrategy(config.strategy),
    option(config.signers, encodeBTreeSetH160),
  );
}

// ====== Routing Fee Config ======

export const ROUTEDOM_DISCRIMINATOR = new Uint8Array([
  0x52,
  0x4f,
  0x55,
  0x54,
  0x45,
  0x44,
  0x4f,
  0x4d, // ROUTEDOM
]);

export const STDQUOTE_DISCRIMINATOR = new Uint8Array([
  0x53,
  0x54,
  0x44,
  0x51,
  0x55,
  0x4f,
  0x54,
  0x45, // STDQUOTE
]);

export interface SvmRoutingFeeConfig {
  wildcardSigners: string[];
}

export function encodeRoutingFeeConfig(
  config: SvmRoutingFeeConfig,
): ReadonlyUint8Array {
  return encodeBTreeSetH160(config.wildcardSigners);
}

// ====== Cross-Collateral Routing Fee Config ======

export const CC_ROUTE_DISCRIMINATOR = new Uint8Array([
  0x43,
  0x43,
  0x5f,
  0x52,
  0x4f,
  0x55,
  0x54,
  0x45, // CC_ROUTE
]);

export interface SvmCrossCollateralRoutingFeeConfig {
  wildcardSigners: string[];
}

export function encodeCrossCollateralRoutingFeeConfig(
  config: SvmCrossCollateralRoutingFeeConfig,
): ReadonlyUint8Array {
  return encodeBTreeSetH160(config.wildcardSigners);
}

// ====== Route Key ======

export const SvmRouteKeyKind = {
  Domain: 0,
  CrossCollateral: 1,
} as const;

export type SvmRouteKey =
  | { kind: typeof SvmRouteKeyKind.Domain; domain: number }
  | {
      kind: typeof SvmRouteKeyKind.CrossCollateral;
      destination: number;
      targetRouter: Uint8Array;
    };

export function encodeRouteKey(key: SvmRouteKey): ReadonlyUint8Array {
  switch (key.kind) {
    case SvmRouteKeyKind.Domain:
      return concatBytes(u8(key.kind), u32le(key.domain));
    case SvmRouteKeyKind.CrossCollateral:
      assert(
        key.targetRouter.length === 32,
        `targetRouter must be 32 bytes, got ${key.targetRouter.length}`,
      );
      return concatBytes(
        u8(key.kind),
        u32le(key.destination),
        key.targetRouter,
      );
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unhandled RouteKey kind: ${String(_exhaustive)}`);
    }
  }
}

// ====== Fee Data (top-level discriminated union) ======

export type SvmFeeData =
  | { kind: typeof FeeDataKind.Leaf; config: SvmLeafFeeConfig }
  | { kind: typeof FeeDataKind.Routing; config: SvmRoutingFeeConfig }
  | {
      kind: typeof FeeDataKind.CrossCollateralRouting;
      config: SvmCrossCollateralRoutingFeeConfig;
    };

export function encodeFeeData(data: SvmFeeData): ReadonlyUint8Array {
  switch (data.kind) {
    case FeeDataKind.Leaf:
      return concatBytes(u8(data.kind), encodeLeafFeeConfig(data.config));
    case FeeDataKind.Routing:
      return concatBytes(u8(data.kind), encodeRoutingFeeConfig(data.config));
    case FeeDataKind.CrossCollateralRouting:
      return concatBytes(
        u8(data.kind),
        encodeCrossCollateralRoutingFeeConfig(data.config),
      );

    default: {
      const _exhaustive: never = data;
      throw new Error(`Unhandled FeeData kind: ${String(_exhaustive)}`);
    }
  }
}
