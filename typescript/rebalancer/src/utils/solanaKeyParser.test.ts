import { expect } from 'chai';

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { parseSolanaPrivateKey } from './solanaKeyParser.js';

describe('parseSolanaPrivateKey', () => {
  it('parses valid 64-byte JSON array', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i);
    const parsed = parseSolanaPrivateKey(JSON.stringify(bytes));

    expect(parsed).to.be.instanceOf(Uint8Array);
    expect(Array.from(parsed)).to.deep.equal(bytes);
    expect(parsed).to.have.length(64);
  });

  it('parses valid 64-byte comma-separated', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i);
    const parsed = parseSolanaPrivateKey(bytes.join(','));

    expect(Array.from(parsed)).to.deep.equal(bytes);
    expect(parsed).to.have.length(64);
  });

  it('parses valid 32-byte seed JSON array and expands to 64 bytes', () => {
    const seed = Array.from({ length: 32 }, (_, i) => i);
    const parsed = parseSolanaPrivateKey(JSON.stringify(seed));
    const expected = Keypair.fromSeed(Uint8Array.from(seed)).secretKey;

    expect(parsed).to.have.length(64);
    expect(Array.from(parsed)).to.deep.equal(Array.from(expected));
  });

  it('parses valid 32-byte seed comma-separated and expands to 64 bytes', () => {
    const seed = Array.from({ length: 32 }, (_, i) => i + 1);
    const parsed = parseSolanaPrivateKey(seed.join(','));
    const expected = Keypair.fromSeed(Uint8Array.from(seed)).secretKey;

    expect(parsed).to.have.length(64);
    expect(Array.from(parsed)).to.deep.equal(Array.from(expected));
  });

  it('throws on "1,2,abc,4" (non-numeric)', () => {
    expect(() => parseSolanaPrivateKey('1,2,abc,4')).to.throw(
      'Comma-separated byte at index 2 is not numeric.',
    );
  });

  it('throws on empty string', () => {
    expect(() => parseSolanaPrivateKey('   ')).to.throw('Input is empty.');
  });

  it('throws on "256,1,2" (out of range)', () => {
    expect(() => parseSolanaPrivateKey('256,1,2')).to.throw(
      'Comma-separated byte at index 0 must be in range 0..255.',
    );
  });

  it('throws on "-1,1,2" (negative)', () => {
    expect(() => parseSolanaPrivateKey('-1,1,2')).to.throw(
      'Comma-separated byte at index 0 must be in range 0..255.',
    );
  });

  it('throws on "1.5,2,3" (non-integer)', () => {
    expect(() => parseSolanaPrivateKey('1.5,2,3')).to.throw(
      'Comma-separated byte at index 0 must be an integer.',
    );
  });

  it('throws on 10-byte array (wrong length)', () => {
    const tenBytes = JSON.stringify(Array.from({ length: 10 }, (_, i) => i));
    expect(() => parseSolanaPrivateKey(tenBytes)).to.throw(
      'Received 10 bytes; expected exactly 32 or 64.',
    );
  });

  it('error message contains HYP_INVENTORY_KEY_SEALEVEL', () => {
    expect(() => parseSolanaPrivateKey('not-a-key')).to.throw(
      'HYP_INVENTORY_KEY_SEALEVEL',
    );
  });

  it('parses valid base58-encoded 64-byte key', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i);
    const base58Key = bs58.encode(Uint8Array.from(bytes));
    const parsed = parseSolanaPrivateKey(base58Key);

    expect(Array.from(parsed)).to.deep.equal(bytes);
    expect(parsed).to.have.length(64);
  });

  it('parses valid base58-encoded 32-byte seed and expands to 64 bytes', () => {
    const seed = Array.from({ length: 32 }, (_, i) => i + 1);
    const base58Seed = bs58.encode(Uint8Array.from(seed));
    const parsed = parseSolanaPrivateKey(base58Seed);
    const expected = Keypair.fromSeed(Uint8Array.from(seed)).secretKey;

    expect(parsed).to.have.length(64);
    expect(Array.from(parsed)).to.deep.equal(Array.from(expected));
  });
});
