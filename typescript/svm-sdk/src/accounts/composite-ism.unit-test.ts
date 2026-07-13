import { type Address, getAddressCodec } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ByteCursor } from '../codecs/binary.js';

import {
  decodeCompositeIsmStorageAccount,
  decodeDomainIsmStorageAccount,
  decodeIsmNode,
  encodeCompositeIsmStorageAccount,
  encodeDomainIsmStorageAccount,
  encodeIsmNode,
  type IsmNode,
} from './composite-ism.js';

const ADDRESS_CODEC = getAddressCodec();

function repeat(byte: number, len: number): Uint8Array {
  return new Uint8Array(len).fill(byte);
}

function addrFromByte(byte: number): Address {
  return ADDRESS_CODEC.decode(repeat(byte, 32));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const RELAYER = addrFromByte(1);
const MAILBOX = addrFromByte(2);
const FALLBACK_ISM = addrFromByte(3);
const RECIPIENT = repeat(4, 32);
const VALIDATOR = repeat(5, 20);

describe('composite-ism Borsh codec', () => {
  // Fixtures below are byte-for-byte cross-checked against
  // `borsh::to_vec(&IsmNode::...)` in
  // rust/sealevel/programs/ism/composite-ism/src/accounts.rs, using
  // Pubkey::new_from_array([N; 32]) / H160::repeat_byte(N) / H256::repeat_byte(N)
  // for N matching the byte values used here.
  const cases: [string, IsmNode, string][] = [
    [
      'trustedRelayer',
      { kind: 'trustedRelayer', relayer: RELAYER },
      '000101010101010101010101010101010101010101010101010101010101010101',
    ],
    [
      'multisigMessageId',
      { kind: 'multisigMessageId', validators: [VALIDATOR], threshold: 7 },
      '0101000000050505050505050505050505050505050505050507',
    ],
    [
      'aggregation',
      {
        kind: 'aggregation',
        threshold: 1,
        subIsms: [
          { kind: 'trustedRelayer', relayer: RELAYER },
          {
            kind: 'multisigMessageId',
            validators: [repeat(0, 20)],
            threshold: 1,
          },
        ],
      },
      '0201020000000001010101010101010101010101010101010101010101010101010101010101010101000000000000000000000000000000000000000000000001',
    ],
    ['test', { kind: 'test', accept: true }, '0301'],
    ['pausable', { kind: 'pausable', paused: true }, '0401'],
    [
      'amountRouting',
      {
        kind: 'amountRouting',
        threshold: 1_000_000n,
        lower: { kind: 'pausable', paused: false },
        upper: { kind: 'test', accept: false },
      },
      '0540420f000000000000000000000000000000000000000000000000000000000004000300',
    ],
    [
      'rateLimited (with recipient)',
      {
        kind: 'rateLimited',
        maxCapacity: 86400n,
        recipient: RECIPIENT,
        filledLevel: 86400n,
        lastUpdated: 0n,
        mailbox: MAILBOX,
      },
      '068051010000000000010404040404040404040404040404040404040404040404040404040404040404805101000000000000000000000000000202020202020202020202020202020202020202020202020202020202020202',
    ],
    [
      'rateLimited (no recipient, negative lastUpdated)',
      {
        kind: 'rateLimited',
        maxCapacity: 86400n,
        recipient: null,
        filledLevel: 12345n,
        lastUpdated: -5n,
        mailbox: MAILBOX,
      },
      '068051010000000000003930000000000000fbffffffffffffff0202020202020202020202020202020202020202020202020202020202020202',
    ],
    ['routing', { kind: 'routing' }, '07'],
    [
      'fallbackRouting',
      { kind: 'fallbackRouting', fallbackIsm: FALLBACK_ISM },
      '080303030303030303030303030303030303030303030303030303030303030303',
    ],
  ];

  for (const [label, node, expectedHex] of cases) {
    it(`encodes ${label} to match the Rust program's Borsh output`, () => {
      expect(hex(encodeIsmNode(node) as Uint8Array)).to.equal(expectedHex);
    });

    it(`round-trips ${label} through encode -> decode`, () => {
      const encoded = encodeIsmNode(node);
      const decoded = decodeIsmNode(new ByteCursor(encoded as Uint8Array));
      expect(decoded).to.deep.equal(node);
    });
  }

  it('decodes an unknown IsmNode kind byte with a clear error', () => {
    const cursor = new ByteCursor(new Uint8Array([99]));
    expect(() => decodeIsmNode(cursor)).to.throw('Unknown IsmNode kind: 99');
  });

  describe('CompositeIsmStorage account (AccountData<T> wrapper)', () => {
    it('round-trips through encode -> decode', () => {
      const storage = {
        bumpSeed: 254,
        owner: addrFromByte(9),
        root: { kind: 'test' as const, accept: true },
      };
      const encoded = encodeCompositeIsmStorageAccount(storage);
      const decoded = decodeCompositeIsmStorageAccount(encoded as Uint8Array);
      expect(decoded).to.deep.equal(storage);
    });

    it('matches the Rust AccountData<CompositeIsmStorage> wire format', () => {
      const storage = {
        bumpSeed: 254,
        owner: addrFromByte(9),
        root: { kind: 'test' as const, accept: true },
      };
      // "01" (initialized=true, AccountData<T> wrapper) + bare
      // `borsh::to_vec(&CompositeIsmStorage{...})` from the Rust program.
      expect(
        hex(encodeCompositeIsmStorageAccount(storage) as Uint8Array),
      ).to.equal(
        '01fe010909090909090909090909090909090909090909090909090909090909090909010301',
      );
    });

    it('returns null for an empty (uninitialized) account', () => {
      expect(decodeCompositeIsmStorageAccount(new Uint8Array(0))).to.be.null;
    });
  });

  describe('DomainIsmStorage account (AccountData<T> wrapper)', () => {
    it('round-trips through encode -> decode', () => {
      const storage = {
        bumpSeed: 254,
        domain: 1234,
        ism: { kind: 'test' as const, accept: true },
      };
      const encoded = encodeDomainIsmStorageAccount(storage);
      const decoded = decodeDomainIsmStorageAccount(encoded as Uint8Array);
      expect(decoded).to.deep.equal(storage);
    });

    it('matches the Rust AccountData<DomainIsmStorage> wire format', () => {
      const storage = {
        bumpSeed: 254,
        domain: 1234,
        ism: { kind: 'test' as const, accept: true },
      };
      expect(
        hex(encodeDomainIsmStorageAccount(storage) as Uint8Array),
      ).to.equal('01fed2040000010301');
    });

    it('returns null for an empty (uninitialized) account', () => {
      expect(decodeDomainIsmStorageAccount(new Uint8Array(0))).to.be.null;
    });
  });
});
