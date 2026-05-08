import { type Address, getAddressDecoder } from '@solana/kit';

import {
  ascii8,
  decodeAccountData,
  decodeDiscriminatorPrefixed,
  readAddress,
} from './account-data.js';
import { type ByteCursor, concatBytes, i64le, u32le } from './binary.js';
import { decodeBTreeSetH160, encodeBTreeSetH160 } from './fee.js';

/**
 * Off-chain quoting configuration on an IGP account.
 *
 * Mirrors the Rust `IgpFeeConfig` struct. `signers` is a `BTreeSet<H160>`
 * on-chain; the encoder (via `encodeBTreeSetH160`) handles sort + dedup.
 * Hex strings (0x-prefixed, lowercase) match how the fee program already
 * exposes signer sets.
 */
export interface IgpFeeConfig {
  signers: string[];
  domainId: number;
  minIssuedAt: bigint;
}

export function encodeIgpFeeConfig(value: IgpFeeConfig): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      encodeBTreeSetH160(value.signers),
      u32le(value.domainId),
      i64le(value.minIssuedAt),
    ),
  );
}

export function decodeIgpFeeConfig(cursor: ByteCursor): IgpFeeConfig {
  const signers = decodeBTreeSetH160(cursor);
  const domainId = cursor.readU32LE();
  const minIssuedAt = cursor.readI64LE();
  return { signers, domainId, minIssuedAt };
}

/**
 * Reads an optional trailing `IgpFeeConfig` from the cursor, mirroring the
 * Rust `read_optional_trailing` semantics:
 *
 *   - no remaining bytes → undefined (pre-upgrade account)
 *   - tag byte `0`        → undefined (explicit None)
 *   - tag byte `1`        → decoded `IgpFeeConfig`
 *   - any other byte      → throws
 */
export function readOptionalTrailingIgpFeeConfig(
  cursor: ByteCursor,
): IgpFeeConfig | undefined {
  if (cursor.remaining() === 0) return undefined;
  const tag = cursor.readU8();
  if (tag === 0) return undefined;
  if (tag !== 1) {
    throw new Error(`Invalid IgpFeeConfig option tag: ${tag}`);
  }
  return decodeIgpFeeConfig(cursor);
}

// ====== IGP standing / transient quote PDAs ======

const IGP_STANDING_QUOTE_DISCRIMINATOR = ascii8('IGPSTQTE');
const IGP_TRANSIENT_QUOTE_DISCRIMINATOR = ascii8('IGPTQOTE');

/**
 * Wildcard sender used in the standing-quote cascade — Pubkey([0xFF; 32]).
 * Matches the on-chain `WILDCARD_SENDER` constant.
 */
export const WILDCARD_SENDER: Address = getAddressDecoder().decode(
  new Uint8Array(32).fill(0xff),
);

/** Wildcard destination domain — `u32::MAX`, matches the on-chain constant. */
export const WILDCARD_DOMAIN = 0xffffffff;

/** Decoded IGP standing quote account data. */
export interface IgpStandingQuoteData {
  bumpSeed: number;
  feeTokenMint: Address;
  destinationDomain: number;
  sender: Address;
  tokenExchangeRate: bigint;
  gasPrice: bigint;
  tokenDecimals: number;
  issuedAt: bigint;
  expiry: bigint;
}

/** Decoded IGP transient quote account data. */
export interface IgpTransientQuoteData {
  bumpSeed: number;
  payer: Address;
  scopedSalt: Uint8Array;
  destinationDomain: number;
  sender: Address;
  tokenExchangeRate: bigint;
  gasPrice: bigint;
  tokenDecimals: number;
  expiry: bigint;
}

export function decodeIgpStandingQuoteAccount(
  raw: Uint8Array,
): IgpStandingQuoteData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(
      cursor,
      IGP_STANDING_QUOTE_DISCRIMINATOR,
      (c) => ({
        bumpSeed: c.readU8(),
        feeTokenMint: readAddress(c),
        destinationDomain: c.readU32LE(),
        sender: readAddress(c),
        tokenExchangeRate: c.readU128LE(),
        gasPrice: c.readU128LE(),
        tokenDecimals: c.readU8(),
        issuedAt: c.readI64LE(),
        expiry: c.readI64LE(),
      }),
    ),
  );
  return wrapped.data;
}

export function decodeIgpTransientQuoteAccount(
  raw: Uint8Array,
): IgpTransientQuoteData | null {
  const wrapped = decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(
      cursor,
      IGP_TRANSIENT_QUOTE_DISCRIMINATOR,
      (c) => ({
        bumpSeed: c.readU8(),
        payer: readAddress(c),
        scopedSalt: c.readBytes(32),
        destinationDomain: c.readU32LE(),
        sender: readAddress(c),
        tokenExchangeRate: c.readU128LE(),
        gasPrice: c.readU128LE(),
        tokenDecimals: c.readU8(),
        expiry: c.readI64LE(),
      }),
    ),
  );
  return wrapped.data;
}
