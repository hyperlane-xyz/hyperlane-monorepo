import type { Address } from '@solana/kit';

import {
  decodeAccountData,
  decodeDiscriminatorPrefixed,
  readAddress,
  readOptionAddress,
} from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import {
  CC_ROUTE_DISCRIMINATOR,
  decodeBTreeSetH160,
  FEE_ACCT_DISCRIMINATOR,
  ROUTEDOM_DISCRIMINATOR,
  STDQUOTE_DISCRIMINATOR,
  type SvmFeeDataStrategy,
} from '../codecs/fee.js';
import { assert, toHexString } from '@hyperlane-xyz/utils';

import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

// ====== Decoded Fee Data ======

export type DecodedFeeData =
  | {
      kind: typeof FeeDataKind.Leaf;
      strategy: SvmFeeDataStrategy;
      signers: string[] | null;
    }
  | {
      kind: typeof FeeDataKind.Routing;
      wildcardSigners: string[];
    }
  | {
      kind: typeof FeeDataKind.CrossCollateralRouting;
      wildcardSigners: string[];
    };

// ====== Fee Account ======

export interface FeeAccountData {
  bumpSeed: number;
  owner: Address | null;
  beneficiary: Address;
  feeData: DecodedFeeData;
  domainId: number;
  minIssuedAt: bigint;
}

export function decodeFeeAccount(raw: Uint8Array): FeeAccountData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(
      cursor,
      FEE_ACCT_DISCRIMINATOR,
      decodeFeeAccountInner,
    ),
  );
  return wrapped.data;
}

// ====== Internal decoders ======

function decodeFeeAccountInner(cursor: ByteCursor): FeeAccountData {
  const bumpSeed = cursor.readU8();
  const owner = readOptionAddress(cursor);
  const beneficiary = readAddress(cursor);
  const feeData = decodeFeeData(cursor);
  const domainId = cursor.readU32LE();
  const minIssuedAt = cursor.readI64LE();

  return { bumpSeed, owner, beneficiary, feeData, domainId, minIssuedAt };
}

function decodeFeeData(cursor: ByteCursor): DecodedFeeData {
  const kind = cursor.readU8();
  switch (kind) {
    case FeeDataKind.Leaf:
      return {
        kind,
        strategy: decodeFeeDataStrategy(cursor),
        signers: readOptionSigners(cursor),
      };
    case FeeDataKind.Routing:
      return {
        kind,
        wildcardSigners: decodeBTreeSetH160(cursor),
      };
    case FeeDataKind.CrossCollateralRouting:
      return {
        kind,
        wildcardSigners: decodeBTreeSetH160(cursor),
      };

    default:
      throw new Error(`Unhandled FeeData kind: ${kind}`);
  }
}

function decodeFeeDataStrategy(cursor: ByteCursor): SvmFeeDataStrategy {
  const kind = cursor.readU8();
  const params = { maxFee: cursor.readU64LE(), halfAmount: cursor.readU64LE() };

  switch (kind) {
    case FeeStrategyKind.Linear:
    case FeeStrategyKind.Regressive:
    case FeeStrategyKind.Progressive:
      return { kind, params };

    default:
      throw new Error(`Unhandled FeeDataStrategy kind: ${kind}`);
  }
}

function readOptionSigners(cursor: ByteCursor): string[] | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  assert(tag === 1, `Invalid Option tag: ${tag}`);
  return decodeBTreeSetH160(cursor);
}

// ====== Route Domain ======

export interface RouteDomainData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: string[] | null;
}

export function decodeRouteDomain(raw: Uint8Array): RouteDomainData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, ROUTEDOM_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      feeData: decodeFeeDataStrategy(c),
      signers: readOptionSigners(c),
    })),
  );
  return wrapped.data;
}

// ====== Cross-Collateral Route ======

export interface CrossCollateralRouteData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: string[] | null;
}

export function decodeCrossCollateralRoute(
  raw: Uint8Array,
): CrossCollateralRouteData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, CC_ROUTE_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      feeData: decodeFeeDataStrategy(c),
      signers: readOptionSigners(c),
    })),
  );
  return wrapped.data;
}

// ====== Standing Quote ======

export interface StandingQuoteEntry {
  issuedAt: bigint;
  expiry: bigint;
  feeData: SvmFeeDataStrategy;
}

export interface StandingQuotePdaData {
  bumpSeed: number;
  quotes: Map<string, StandingQuoteEntry>;
}

export function decodeStandingQuotePda(
  raw: Uint8Array,
): StandingQuotePdaData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, STDQUOTE_DISCRIMINATOR, (c) => ({
      bumpSeed: c.readU8(),
      quotes: decodeMapH256StandingQuoteEntry(c),
    })),
  );
  return wrapped.data;
}

// ====== Internal helpers ======

function decodeStandingQuoteEntry(cursor: ByteCursor): StandingQuoteEntry {
  const issuedAt = cursor.readI64LE();
  const expiry = cursor.readI64LE();
  const feeData = decodeFeeDataStrategy(cursor);
  return { issuedAt, expiry, feeData };
}

function decodeMapH256StandingQuoteEntry(
  cursor: ByteCursor,
): Map<string, StandingQuoteEntry> {
  const count = cursor.readU32LE();
  const entries = new Map<string, StandingQuoteEntry>();
  for (let i = 0; i < count; i++) {
    const keyHex = toHexString(Buffer.from(cursor.readBytes(32)));
    entries.set(keyHex, decodeStandingQuoteEntry(cursor));
  }
  return entries;
}
