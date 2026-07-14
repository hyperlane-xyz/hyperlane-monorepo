import {
  type Address,
  getAddressDecoder,
  type ReadonlyUint8Array,
} from '@solana/kit';

import { ByteCursor } from './binary.js';

export interface DecodedAccountData<T> {
  initialized: boolean;
  data: T | null;
}

export function decodeAccountData<T>(
  raw: ReadonlyUint8Array,
  decodeInner: (cursor: ByteCursor) => T,
): DecodedAccountData<T> {
  if (raw.length === 0) return { initialized: false, data: null };
  const cursor = new ByteCursor(raw);
  const initialized = cursor.readBool();
  if (!initialized) {
    return { initialized: false, data: null };
  }
  return { initialized: true, data: decodeInner(cursor) };
}

export function decodeDiscriminatorPrefixed<T>(
  cursor: ByteCursor,
  expectedDiscriminator: Uint8Array,
  decodeInner: (cursor: ByteCursor) => T,
): T {
  const discriminator = cursor.readBytes(expectedDiscriminator.length);
  const mismatch = discriminator.some(
    (value, i) => value !== expectedDiscriminator[i],
  );
  if (mismatch) {
    throw new Error('Invalid discriminator');
  }
  return decodeInner(cursor);
}

export function decodeDiscriminatedAccount<T>(
  raw: Uint8Array,
  discriminator: Uint8Array,
  inner: (cursor: ByteCursor) => T,
): T | null {
  return decodeAccountData(raw, (cursor) =>
    decodeDiscriminatorPrefixed(cursor, discriminator, inner),
  ).data;
}

/** Builds an 8-byte discriminator from an ASCII string. */
export function ascii8(value: string): Uint8Array {
  if (value.length !== 8) {
    throw new Error(`Expected 8-char discriminator, got ${value}`);
  }
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

const addressDecoder = getAddressDecoder();

/** Reads a 32-byte Pubkey as a base58 Address. */
export function readAddress(cursor: ByteCursor): Address {
  return addressDecoder.decode(cursor.readBytes(32));
}

/** Reads a Borsh `Option<Pubkey>`: 0 ⇒ null, 1 ⇒ address, other ⇒ throws. */
export function readOptionAddress(cursor: ByteCursor): Address | null {
  const tag = cursor.readU8();
  if (tag === 0) return null;
  if (tag !== 1) {
    throw new Error(`Invalid Option tag: ${tag}`);
  }
  return readAddress(cursor);
}
