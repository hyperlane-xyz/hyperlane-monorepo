import {
  type Address,
  getAddressCodec,
  type ReadonlyUint8Array,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { decodeAccountData } from '../codecs/account-data.js';
import {
  bool,
  type ByteCursor,
  concatBytes,
  i64le,
  option,
  u256le,
  u32le,
  u64le,
  u8,
  vec,
} from '../codecs/binary.js';
import {
  decodeH160,
  decodeH256,
  encodeH160,
  encodeH256,
  type H160,
  type H256,
} from '../codecs/shared.js';

const ADDRESS_CODEC = getAddressCodec();

/**
 * Discriminants for `IsmNode` (rust/sealevel/programs/ism/composite-ism/src/accounts.rs).
 * Order is load-bearing — Borsh encodes enum variants as a u8 index matching
 * Rust declaration order, not an explicit discriminant.
 */
export enum IsmNodeKind {
  TrustedRelayer = 0,
  MultisigMessageId = 1,
  Aggregation = 2,
  Test = 3,
  Pausable = 4,
  AmountRouting = 5,
  RateLimited = 6,
  Routing = 7,
  FallbackRouting = 8,
}

/**
 * TS mirror of the on-chain `IsmNode` enum. Distinct from
 * `CompositeIsmNodeConfig` (provider-sdk/sdk) — this is the wire-level type
 * used for Borsh encode/decode; addresses/hashes are raw bytes or base58
 * `Address`, not hex strings, and `routing`/`fallbackRouting` carry no inline
 * domain map (domains live in separate `DomainIsmStorage` PDAs).
 */
export type IsmNode =
  | { kind: 'trustedRelayer'; relayer: Address }
  | { kind: 'multisigMessageId'; validators: H160[]; threshold: number }
  | { kind: 'aggregation'; threshold: number; subIsms: IsmNode[] }
  | { kind: 'test'; accept: boolean }
  | { kind: 'pausable'; paused: boolean }
  | { kind: 'amountRouting'; threshold: bigint; lower: IsmNode; upper: IsmNode }
  | {
      kind: 'rateLimited';
      maxCapacity: bigint;
      recipient: H256 | null;
      filledLevel: bigint;
      lastUpdated: bigint;
      mailbox: Address;
    }
  | { kind: 'routing' }
  | { kind: 'fallbackRouting'; fallbackIsm: Address };

export function encodeIsmNode(node: IsmNode): ReadonlyUint8Array {
  switch (node.kind) {
    case 'trustedRelayer':
      return concatBytes(
        u8(IsmNodeKind.TrustedRelayer),
        ADDRESS_CODEC.encode(node.relayer),
      );
    case 'multisigMessageId':
      return concatBytes(
        u8(IsmNodeKind.MultisigMessageId),
        vec(node.validators, encodeH160),
        u8(node.threshold),
      );
    case 'aggregation':
      return concatBytes(
        u8(IsmNodeKind.Aggregation),
        u8(node.threshold),
        vec(node.subIsms, encodeIsmNode),
      );
    case 'test':
      return concatBytes(u8(IsmNodeKind.Test), bool(node.accept));
    case 'pausable':
      return concatBytes(u8(IsmNodeKind.Pausable), bool(node.paused));
    case 'amountRouting':
      return concatBytes(
        u8(IsmNodeKind.AmountRouting),
        u256le(node.threshold),
        encodeIsmNode(node.lower),
        encodeIsmNode(node.upper),
      );
    case 'rateLimited':
      return concatBytes(
        u8(IsmNodeKind.RateLimited),
        u64le(node.maxCapacity),
        option(node.recipient, encodeH256),
        u64le(node.filledLevel),
        i64le(node.lastUpdated),
        ADDRESS_CODEC.encode(node.mailbox),
      );
    case 'routing':
      return u8(IsmNodeKind.Routing);
    case 'fallbackRouting':
      return concatBytes(
        u8(IsmNodeKind.FallbackRouting),
        ADDRESS_CODEC.encode(node.fallbackIsm),
      );
  }
}

export function decodeIsmNode(cursor: ByteCursor): IsmNode {
  const kind = cursor.readU8();
  switch (kind) {
    case IsmNodeKind.TrustedRelayer:
      return { kind: 'trustedRelayer', relayer: readAddress(cursor) };
    case IsmNodeKind.MultisigMessageId: {
      const count = cursor.readU32LE();
      const validators: H160[] = [];
      for (let i = 0; i < count; i += 1) validators.push(decodeH160(cursor));
      const threshold = cursor.readU8();
      return { kind: 'multisigMessageId', validators, threshold };
    }
    case IsmNodeKind.Aggregation: {
      const threshold = cursor.readU8();
      const count = cursor.readU32LE();
      const subIsms: IsmNode[] = [];
      for (let i = 0; i < count; i += 1) subIsms.push(decodeIsmNode(cursor));
      return { kind: 'aggregation', threshold, subIsms };
    }
    case IsmNodeKind.Test:
      return { kind: 'test', accept: cursor.readBool() };
    case IsmNodeKind.Pausable:
      return { kind: 'pausable', paused: cursor.readBool() };
    case IsmNodeKind.AmountRouting: {
      const threshold = cursor.readU256LE();
      const lower = decodeIsmNode(cursor);
      const upper = decodeIsmNode(cursor);
      return { kind: 'amountRouting', threshold, lower, upper };
    }
    case IsmNodeKind.RateLimited: {
      const maxCapacity = cursor.readU64LE();
      const recipient = readOptionH256(cursor);
      const filledLevel = cursor.readU64LE();
      const lastUpdated = cursor.readI64LE();
      const mailbox = readAddress(cursor);
      return {
        kind: 'rateLimited',
        maxCapacity,
        recipient,
        filledLevel,
        lastUpdated,
        mailbox,
      };
    }
    case IsmNodeKind.Routing:
      return { kind: 'routing' };
    case IsmNodeKind.FallbackRouting:
      return { kind: 'fallbackRouting', fallbackIsm: readAddress(cursor) };
    default:
      throw new Error(`Unknown IsmNode kind: ${kind}`);
  }
}

function readAddress(cursor: ByteCursor): Address {
  return ADDRESS_CODEC.decode(cursor.readBytes(32));
}

function readOptionH256(cursor: ByteCursor): H256 | null {
  const tag = cursor.readU8();
  assert(tag === 0 || tag === 1, `Invalid Option tag: ${tag}`);
  return tag === 1 ? decodeH256(cursor) : null;
}

/** Data stored in the VAM PDA account (see `deriveCompositeIsmStoragePda`). */
export interface CompositeIsmStorage {
  bumpSeed: number;
  owner: Address | null;
  root: IsmNode | null;
}

export function decodeCompositeIsmStorageAccount(
  raw: Uint8Array,
): CompositeIsmStorage | null {
  const wrapped = decodeAccountData(raw, (cursor) => {
    const bumpSeed = cursor.readU8();
    const ownerTag = cursor.readU8();
    assert(ownerTag === 0 || ownerTag === 1, `Invalid Option tag: ${ownerTag}`);
    const owner = ownerTag === 1 ? readAddress(cursor) : null;
    const rootTag = cursor.readU8();
    assert(rootTag === 0 || rootTag === 1, `Invalid Option tag: ${rootTag}`);
    const root = rootTag === 1 ? decodeIsmNode(cursor) : null;
    return { bumpSeed, owner, root };
  });
  return wrapped.data;
}

/** Data stored in a per-domain PDA account for `Routing`/`FallbackRouting` nodes. */
export interface DomainIsmStorage {
  bumpSeed: number;
  domain: number;
  ism: IsmNode | null;
}

export function decodeDomainIsmStorageAccount(
  raw: Uint8Array,
): DomainIsmStorage | null {
  const wrapped = decodeAccountData(raw, (cursor) => {
    const bumpSeed = cursor.readU8();
    const domain = cursor.readU32LE();
    const ismTag = cursor.readU8();
    assert(ismTag === 0 || ismTag === 1, `Invalid Option tag: ${ismTag}`);
    const ism = ismTag === 1 ? decodeIsmNode(cursor) : null;
    return { bumpSeed, domain, ism };
  });
  return wrapped.data;
}

/**
 * Encodes a full `CompositeIsmStorage` account body, including the leading
 * `initialized` byte from the `AccountData<T>` wrapper. Used for tests only
 * (production code never writes raw storage bytes — mutation happens via
 * instructions and the program itself serializes the account).
 */
export function encodeCompositeIsmStorageAccount(
  storage: CompositeIsmStorage,
): ReadonlyUint8Array {
  return concatBytes(
    bool(true),
    u8(storage.bumpSeed),
    option(storage.owner, (owner) => ADDRESS_CODEC.encode(owner)),
    option(storage.root, encodeIsmNode),
  );
}

/** Test-only encoder for `DomainIsmStorage`, see {@link encodeCompositeIsmStorageAccount}. */
export function encodeDomainIsmStorageAccount(
  storage: DomainIsmStorage,
): ReadonlyUint8Array {
  return concatBytes(
    bool(true),
    u8(storage.bumpSeed),
    u32le(storage.domain),
    option(storage.ism, encodeIsmNode),
  );
}
