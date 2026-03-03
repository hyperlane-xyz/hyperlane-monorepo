import {
  addCodecSizePrefix,
  type Decoder,
  getBase16Codec,
  getBooleanCodec,
  getBytesCodec,
  getU128Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  getUtf8Codec,
  type ReadonlyUint8Array,
} from '@solana/kit';

const U8_CODEC = getU8Codec();
const BOOL_CODEC = getBooleanCodec();
const U32_CODEC = getU32Codec();
const U64_CODEC = getU64Codec();
const U128_CODEC = getU128Codec();
const UTF8_CODEC = getUtf8Codec();
const BASE16_CODEC = getBase16Codec();
const VEC_BYTES_CODEC = addCodecSizePrefix(getBytesCodec(), U32_CODEC);

export class ByteCursor {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  readU8(): number {
    this.ensure(1);
    const value = U8_CODEC.decode(
      this.data.slice(this.offset, this.offset + 1),
    );
    this.offset += 1;
    return value;
  }

  readBool(): boolean {
    this.ensure(1);
    const value = BOOL_CODEC.decode(
      this.data.slice(this.offset, this.offset + 1),
    );
    this.offset += 1;
    return value;
  }

  readU32LE(): number {
    this.ensure(4);
    const value = U32_CODEC.decode(
      this.data.slice(this.offset, this.offset + 4),
    );
    this.offset += 4;
    return value;
  }

  readU64LE(): bigint {
    this.ensure(8);
    const value = U64_CODEC.decode(
      this.data.slice(this.offset, this.offset + 8),
    );
    this.offset += 8;
    return value;
  }

  readU128LE(): bigint {
    this.ensure(16);
    const value = U128_CODEC.decode(
      this.data.slice(this.offset, this.offset + 16),
    );
    this.offset += 16;
    return value;
  }

  readU256LE(): bigint {
    return readBigIntLE(this.readBytes(32));
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const start = this.offset;
    this.offset += length;
    return this.data.slice(start, this.offset);
  }

  readVecBytes(): Uint8Array {
    return this.readBytes(this.readU32LE());
  }

  readString(): string {
    return UTF8_CODEC.decode(this.readVecBytes());
  }

  readWithDecoder<T>(decoder: Decoder<T>): T {
    const [value, nextOffset] = decoder.read(this.data, this.offset);
    this.offset = nextOffset;
    return value;
  }

  private ensure(length: number): void {
    if (this.remaining() < length) {
      throw new Error(
        `Buffer underflow: need ${length}, remaining ${this.remaining()}`,
      );
    }
  }
}

export function concatBytes(
  ...parts: readonly ArrayLike<number>[]
): ReadonlyUint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u8(value: number): ReadonlyUint8Array {
  return U8_CODEC.encode(value);
}

export function bool(value: boolean): ReadonlyUint8Array {
  return BOOL_CODEC.encode(value);
}

export function u32le(value: number): ReadonlyUint8Array {
  return U32_CODEC.encode(value);
}

export function u64le(value: bigint): ReadonlyUint8Array {
  return U64_CODEC.encode(value);
}

export function u128le(value: bigint): ReadonlyUint8Array {
  return U128_CODEC.encode(value);
}

export function u256le(value: bigint): ReadonlyUint8Array {
  return writeBigIntLE(value, 32);
}

export function vecBytes(bytes: ReadonlyUint8Array): ReadonlyUint8Array {
  return VEC_BYTES_CODEC.encode(bytes);
}

export function vec<T>(
  items: readonly T[],
  encodeItem: (item: T) => ArrayLike<number>,
): ReadonlyUint8Array {
  return concatBytes(u32le(items.length), ...items.map(encodeItem));
}

export function option<T>(
  item: T | null | undefined,
  encodeItem: (value: T) => ArrayLike<number>,
): ReadonlyUint8Array {
  if (item == null) return u8(0);
  return concatBytes(u8(1), encodeItem(item));
}

export function mapU32<T>(
  entries: Iterable<[number, T]>,
  encodeValue: (value: T) => ArrayLike<number>,
): ReadonlyUint8Array {
  const materialized = Array.from(entries);
  return concatBytes(
    u32le(materialized.length),
    ...materialized.map(([k, v]) => concatBytes(u32le(k), encodeValue(v))),
  );
}

export function addressBytes(
  input: string | ReadonlyUint8Array,
): ReadonlyUint8Array {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string' && input.startsWith('0x')) {
    return BASE16_CODEC.encode(input.slice(2).toLowerCase());
  }
  throw new Error(
    `Expected raw bytes or 0x-prefixed hex string, got: ${input.slice(0, 12)}`,
  );
}

export function ensureLength(
  bytes: ReadonlyUint8Array,
  length: number,
  label: string,
): ReadonlyUint8Array {
  if (bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function readBigIntLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    result |= BigInt(bytes[i]!) << (8n * BigInt(i));
  }
  return result;
}

export function writeBigIntLE(value: bigint, length: number): Uint8Array {
  if (value < 0n) throw new Error('Negative bigint not supported');
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = 0; i < length; i += 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining > 0n) {
    throw new Error(`Integer does not fit in ${length} bytes`);
  }
  return out;
}
