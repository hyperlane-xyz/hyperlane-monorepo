import {
  type Address,
  address as parseAddress,
  getAddressDecoder,
  getAddressEncoder,
  type ReadonlyUint8Array,
} from '@solana/kit';

import {
  ascii8,
  decodeAccountData,
  decodeDiscriminatorPrefixed,
  readAddress,
} from './account-data.js';
import {
  type ByteCursor,
  concatBytes,
  ensureLength,
  i64le,
  option,
  u8,
  u32le,
  u128le,
} from './binary.js';
import { decodeBTreeSetH160, encodeBTreeSetH160 } from './fee.js';

const addressEncoder = getAddressEncoder();

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

const IGP_FEE_CONFIG_DISCRIMINATOR = ascii8('IGPFEEV1');

/**
 * Reads an optional trailing `IgpFeeConfig` (on-chain
 * `OptionalDiscriminatedData<IgpFeeConfig>`):
 *
 *   - fewer than 8 trailing bytes            → undefined (pre-upgrade / None)
 *   - 8-byte `IGPFEEV1` discriminator + body → decoded `IgpFeeConfig`
 *   - any other 8-byte tail                  → undefined (stale bytes, tolerated
 *                                               as None, matching the on-chain
 *                                               deserializer)
 */
export function readOptionalTrailingIgpFeeConfig(
  cursor: ByteCursor,
): IgpFeeConfig | undefined {
  if (cursor.remaining() < 8) return undefined;
  const discriminator = cursor.readBytes(8);
  const mismatch = discriminator.some(
    (value, i) => value !== IGP_FEE_CONFIG_DISCRIMINATOR[i],
  );
  if (mismatch) return undefined;
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

// ====== IGP quote context + data (signed bytes) ======

/**
 * Inputs for the offchain IGP signer's `context` slot — the 68 bytes the
 * on-chain `OffchainQuotedIGP` mirror reads on submit. Layout:
 *
 *     [0:32]  fee_token_mint     (Pubkey, zero for SOL)
 *     [32:36] destination_domain (u32 LE)
 *     [36:68] sender             (Pubkey of the dispatching warp router)
 *
 * Pubkey fields accept plain base58 strings; parsing happens internally so
 * callers don't need to import `address` from `@solana/kit` themselves.
 */
export interface SvmIgpQuoteContextInput {
  feeTokenMint: string;
  destinationDomain: number;
  sender: string;
}

export function encodeSvmIgpQuoteContext(
  input: SvmIgpQuoteContextInput,
): ReadonlyUint8Array {
  return concatBytes(
    addressEncoder.encode(parseAddress(input.feeTokenMint)),
    u32le(input.destinationDomain),
    addressEncoder.encode(parseAddress(input.sender)),
  );
}

/**
 * Inputs for the offchain IGP signer's `data` slot — the 33 bytes that drive
 * the on-chain quote cascade's pricing. Mirrors the standing/transient quote
 * account fields:
 *
 *     [0:16]  token_exchange_rate (u128 LE)
 *     [16:32] gas_price           (u128 LE)
 *     [32:33] token_decimals      (u8)
 */
export interface SvmIgpQuoteDataInput {
  tokenExchangeRate: bigint;
  gasPrice: bigint;
  tokenDecimals: number;
}

export function encodeSvmIgpQuoteData(
  input: SvmIgpQuoteDataInput,
): ReadonlyUint8Array {
  return concatBytes(
    u128le(input.tokenExchangeRate),
    u128le(input.gasPrice),
    u8(input.tokenDecimals),
  );
}

// ====== GetIgpQuoteAccountMetas input ======

const SCOPED_SALT_LEN = 32;

/** Input data for the simulation-only `GetIgpQuoteAccountMetas` instruction. */
export interface GetIgpQuoteAccountMetasInput {
  destinationDomain: number;
  /** Warp route program ID (`quoted_sender` on-chain). */
  sender: Address;
  /** When set, queries the transient-quote PDA for this scoped salt. */
  scopedSalt?: Uint8Array;
}

export function encodeGetIgpQuoteAccountMetasInput(
  input: GetIgpQuoteAccountMetasInput,
): Uint8Array {
  if (input.scopedSalt !== undefined) {
    ensureLength(input.scopedSalt, SCOPED_SALT_LEN, 'scopedSalt');
  }
  return Uint8Array.from(
    concatBytes(
      u32le(input.destinationDomain),
      addressEncoder.encode(input.sender),
      option(input.scopedSalt ?? null, (salt) => salt),
    ),
  );
}

export function decodeGetIgpQuoteAccountMetasInput(
  cursor: ByteCursor,
): GetIgpQuoteAccountMetasInput {
  const destinationDomain = cursor.readU32LE();
  const sender = readAddress(cursor);
  const tag = cursor.readU8();
  if (tag === 0) return { destinationDomain, sender };
  if (tag !== 1) {
    throw new Error(`Invalid scopedSalt option tag: ${tag}`);
  }
  return {
    destinationDomain,
    sender,
    scopedSalt: cursor.readBytes(SCOPED_SALT_LEN),
  };
}
