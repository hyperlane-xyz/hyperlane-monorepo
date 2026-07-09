import { type Address, getAddressDecoder } from '@solana/kit';

import { decodeDiscriminatedAccount } from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import {
  CC_ROUTE_DISCRIMINATOR,
  FEE_ACCT_DISCRIMINATOR,
  ROUTEDOM_DISCRIMINATOR,
  STDQUOTE_DISCRIMINATOR,
  type SvmFeeDataStrategy,
} from '../codecs/fee.js';
import { assert, toHexString } from '@hyperlane-xyz/utils';

import { FeeDataKind, FeeStrategyKind, h160ToSigner } from '../fee/types.js';

const addressDecoder = getAddressDecoder();

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
  return decodeDiscriminatedAccount(
    raw,
    FEE_ACCT_DISCRIMINATOR,
    decodeFeeAccountInner,
  );
}

// ====== Internal decoders ======

function decodeFeeAccountInner(cursor: ByteCursor): FeeAccountData {
  const bumpSeed = cursor.readU8();
  const owner = readOptionAddress(cursor);
  const beneficiary = readAddress(cursor);
  const domainId = cursor.readU32LE();
  const minIssuedAt = cursor.readI64LE();
  const feeData = decodeFeeData(cursor);

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
        wildcardSigners: readSigners(cursor),
      };
    case FeeDataKind.CrossCollateralRouting:
      return {
        kind,
        wildcardSigners: readSigners(cursor),
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
  return readSigners(cursor);
}

// ====== Route Domain ======

export interface RouteDomainData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: string[] | null;
}

export function decodeRouteDomain(raw: Uint8Array): RouteDomainData | null {
  return decodeDiscriminatedAccount(raw, ROUTEDOM_DISCRIMINATOR, (c) => ({
    bumpSeed: c.readU8(),
    feeData: decodeFeeDataStrategy(c),
    signers: readOptionSigners(c),
  }));
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
  return decodeDiscriminatedAccount(raw, CC_ROUTE_DISCRIMINATOR, (c) => ({
    bumpSeed: c.readU8(),
    feeData: decodeFeeDataStrategy(c),
    signers: readOptionSigners(c),
  }));
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
  return decodeDiscriminatedAccount(raw, STDQUOTE_DISCRIMINATOR, (c) => ({
    bumpSeed: c.readU8(),
    quotes: decodeMapH256StandingQuoteEntry(c),
  }));
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

function readSigners(cursor: ByteCursor): string[] {
  const count = cursor.readU32LE();
  const signers: string[] = [];
  for (let i = 0; i < count; i++) {
    signers.push(h160ToSigner(cursor.readBytes(20)));
  }
  return signers;
}

function readAddress(cursor: ByteCursor): Address {
  return addressDecoder.decode(cursor.readBytes(32));
}

function readOptionAddress(cursor: ByteCursor): Address | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  assert(tag === 1, `Invalid Option tag: ${tag}`);
  return readAddress(cursor);
}
