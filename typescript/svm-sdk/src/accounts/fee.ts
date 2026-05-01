import { type Address, getAddressDecoder } from '@solana/kit';

import {
  decodeAccountData,
  decodeDiscriminatorPrefixed,
} from '../codecs/account-data.js';
import type { ByteCursor } from '../codecs/binary.js';
import {
  FEE_ACCT_DISCRIMINATOR,
  type SvmFeeDataStrategy,
} from '../codecs/fee.js';
import { FeeDataKind, FeeStrategyKind } from '../fee/types.js';

const addressDecoder = getAddressDecoder();

// ====== Decoded Fee Data ======

export type DecodedFeeData = {
  kind: typeof FeeDataKind.Leaf;
  strategy: SvmFeeDataStrategy;
  signers: Uint8Array[] | null;
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

function readAddress(cursor: ByteCursor): Address {
  return addressDecoder.decode(cursor.readBytes(32));
}

function readOptionAddress(cursor: ByteCursor): Address | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  return readAddress(cursor);
}
