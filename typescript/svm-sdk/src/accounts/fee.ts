import { type Address, getAddressDecoder } from '@solana/kit';

import {
  decodeAccountData,
  decodeDiscriminatorPrefixed,
} from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import {
  FEE_ACCOUNT_DISCRIMINATOR,
  ROUTE_DOMAIN_DISCRIMINATOR,
  CC_ROUTE_DISCRIMINATOR,
  TRANSIENT_QUOTE_DISCRIMINATOR,
  STANDING_QUOTE_DISCRIMINATOR,
  type SvmFeeDataStrategy,
} from '../codecs/fee.js';
import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

const addressDecoder = getAddressDecoder();

// ── Decoded data types ──────────────────────────────────────────────

export interface FeeAccountData {
  bumpSeed: number;
  owner: Address | null;
  beneficiary: Address;
  feeData: DecodedFeeData;
  domainId: number;
  minIssuedAt: bigint;
  standingQuoteDomains: Set<number>;
}

export type DecodedFeeData =
  | {
      kind: typeof FeeDataKind.Leaf;
      strategy: SvmFeeDataStrategy;
      signers: Uint8Array[] | null;
    }
  | {
      kind: typeof FeeDataKind.Routing;
      wildcardSigners: Uint8Array[];
    }
  | {
      kind: typeof FeeDataKind.CrossCollateralRouting;
      wildcardSigners: Uint8Array[];
    };

export interface RouteDomainData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
}

export interface CrossCollateralRouteData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
}

export interface TransientQuoteData {
  bumpSeed: number;
  payer: Address;
  scopedSalt: Uint8Array;
  context: Uint8Array;
  data: Uint8Array;
  expiry: bigint;
}

export interface StandingQuoteEntry {
  issuedAt: bigint;
  expiry: bigint;
  maxFee: bigint;
  halfAmount: bigint;
  authScope: number;
}

export interface StandingQuotePdaData {
  bumpSeed: number;
  quotes: Map<string, StandingQuoteEntry>;
}

// ── Decoders ────────────────────────────────────────────────────────

export function decodeFeeAccount(raw: Uint8Array): FeeAccountData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, FEE_ACCOUNT_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      owner: readOptionAddress(c),
      beneficiary: readAddress(c),
      feeData: decodeFeeData(c),
      domainId: c.readU32LE(),
      minIssuedAt: c.readI64LE(),
      standingQuoteDomains: readBTreeSetU32(c),
    })),
  );
  return wrapped.data;
}

export function decodeRouteDomain(raw: Uint8Array): RouteDomainData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, ROUTE_DOMAIN_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      feeData: decodeFeeDataStrategy(c),
      signers: readOptionalBTreeSetH160(c),
    })),
  );
  return wrapped.data;
}

export function decodeCrossCollateralRoute(
  raw: Uint8Array,
): CrossCollateralRouteData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, CC_ROUTE_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      feeData: decodeFeeDataStrategy(c),
      signers: readOptionalBTreeSetH160(c),
    })),
  );
  return wrapped.data;
}

export function decodeTransientQuote(
  raw: Uint8Array,
): TransientQuoteData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, TRANSIENT_QUOTE_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      payer: readAddress(c),
      scopedSalt: c.readBytes(32),
      context: readVecBytes(c),
      data: readVecBytes(c),
      expiry: c.readI64LE(),
    })),
  );
  return wrapped.data;
}

export function decodeStandingQuotePda(
  raw: Uint8Array,
): StandingQuotePdaData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, STANDING_QUOTE_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      quotes: readStandingQuoteMap(c),
    })),
  );
  return wrapped.data;
}

// ── Internal helpers ────────────────────────────────────────────────

function readAddress(c: ByteCursor): Address {
  return c.readWithDecoder(addressDecoder);
}

function readOptionAddress(c: ByteCursor): Address | null {
  const tag = c.readU8();
  if (tag === 0) return null;
  return readAddress(c);
}

function isFeeStrategyKind(value: number): value is FeeStrategyKind {
  return (
    value === FeeStrategyKind.Linear ||
    value === FeeStrategyKind.Regressive ||
    value === FeeStrategyKind.Progressive
  );
}

function decodeFeeDataStrategy(c: ByteCursor): SvmFeeDataStrategy {
  const kind = c.readU8();
  if (!isFeeStrategyKind(kind)) {
    throw new Error(`Unknown FeeDataStrategy kind: ${kind}`);
  }
  const params = { maxFee: c.readU64LE(), halfAmount: c.readU64LE() };
  return { kind, params };
}

function decodeFeeData(c: ByteCursor): DecodedFeeData {
  const kind = c.readU8();
  switch (kind) {
    case FeeDataKind.Leaf:
      return {
        kind: FeeDataKind.Leaf,
        strategy: decodeFeeDataStrategy(c),
        signers: readOptionalBTreeSetH160(c),
      };
    case FeeDataKind.Routing:
      return {
        kind: FeeDataKind.Routing,
        wildcardSigners: readBTreeSetH160(c),
      };
    case FeeDataKind.CrossCollateralRouting:
      return {
        kind: FeeDataKind.CrossCollateralRouting,
        wildcardSigners: readBTreeSetH160(c),
      };
    default:
      throw new Error(`Unknown FeeData kind: ${kind}`);
  }
}

function readBTreeSetH160(c: ByteCursor): Uint8Array[] {
  const len = c.readU32LE();
  const result: Uint8Array[] = [];
  for (let i = 0; i < len; i++) {
    result.push(c.readBytes(20));
  }
  return result;
}

function readOptionalBTreeSetH160(c: ByteCursor): Uint8Array[] | null {
  const tag = c.readU8();
  if (tag === 0) return null;
  return readBTreeSetH160(c);
}

function readBTreeSetU32(c: ByteCursor): Set<number> {
  const len = c.readU32LE();
  const result = new Set<number>();
  for (let i = 0; i < len; i++) {
    result.add(c.readU32LE());
  }
  return result;
}

function readVecBytes(c: ByteCursor): Uint8Array {
  const len = c.readU32LE();
  return c.readBytes(len);
}

function readStandingQuoteMap(c: ByteCursor): Map<string, StandingQuoteEntry> {
  const len = c.readU32LE();
  const result = new Map<string, StandingQuoteEntry>();
  for (let i = 0; i < len; i++) {
    const recipientBytes = c.readBytes(32);
    const key = Array.from(recipientBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const entry: StandingQuoteEntry = {
      issuedAt: c.readI64LE(),
      expiry: c.readI64LE(),
      maxFee: c.readU64LE(),
      halfAmount: c.readU64LE(),
      authScope: c.readU8(),
    };
    result.set(key, entry);
  }
  return result;
}
