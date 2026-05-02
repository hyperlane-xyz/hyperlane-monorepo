import { type Address, getAddressDecoder } from '@solana/kit';

import {
  decodeAccountData,
  decodeDiscriminatorPrefixed,
} from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import {
  FEE_ACCT_DISCRIMINATOR,
  ROUTEDOM_DISCRIMINATOR,
  STDQUOTE_DISCRIMINATOR,
  type SvmFeeDataStrategy,
} from '../codecs/fee.js';
import { toHexString } from '@hyperlane-xyz/utils';

import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

const addressDecoder = getAddressDecoder();

// ====== Decoded Fee Data ======

export type DecodedFeeData =
  | {
      kind: typeof FeeDataKind.Leaf;
      strategy: SvmFeeDataStrategy;
      signers: Uint8Array[] | null;
    }
  | {
      kind: typeof FeeDataKind.Routing;
      wildcardSigners: Uint8Array[];
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

function readOptionSigners(cursor: ByteCursor): Uint8Array[] | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  // BTreeSet<H160> is serialized as length-prefixed sorted array
  const count = cursor.readU32LE();
  const signers: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    signers.push(cursor.readBytes(20));
  }
  return signers;
}

// ====== Route Domain ======

export interface RouteDomainData {
  bumpSeed: number;
  feeData: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
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

function readSigners(cursor: ByteCursor): Uint8Array[] {
  const count = cursor.readU32LE();
  const signers: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    signers.push(cursor.readBytes(20));
  }
  return signers;
}

function readAddress(cursor: ByteCursor): Address {
  return addressDecoder.decode(cursor.readBytes(32));
}

function readOptionAddress(cursor: ByteCursor): Address | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  return readAddress(cursor);
}
