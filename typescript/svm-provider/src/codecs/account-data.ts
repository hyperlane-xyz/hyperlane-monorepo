import { ByteCursor } from './binary.js';

export interface DecodedAccountData<T> {
  initialized: boolean;
  data: T | null;
}

export function decodeAccountData<T>(
  raw: Uint8Array,
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
