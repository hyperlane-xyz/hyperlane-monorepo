import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';
import { hexToBytes, keccak256 } from 'viem';

import { computeSealevelScopedSalt } from './SealevelQuotedTransferProvider.js';

const PAYER = new PublicKey('11111111111111111111111111111111');

describe('computeSealevelScopedSalt', () => {
  it('is deterministic for the same (payer, clientSalt)', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const a = computeSealevelScopedSalt(PAYER, salt);
    const b = computeSealevelScopedSalt(PAYER, salt);
    expect([...a]).to.deep.equal([...b]);
  });

  it('returns 32 bytes', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const scoped = computeSealevelScopedSalt(PAYER, salt);
    expect(scoped.length).to.equal(32);
  });

  it('differs when only the client salt changes', () => {
    const a = computeSealevelScopedSalt(PAYER, new Uint8Array(32).fill(0x42));
    const b = computeSealevelScopedSalt(PAYER, new Uint8Array(32).fill(0x43));
    expect([...a]).to.not.deep.equal([...b]);
  });

  it('differs when only the payer changes', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const other = new PublicKey('SysvarRent111111111111111111111111111111111');
    const a = computeSealevelScopedSalt(PAYER, salt);
    const b = computeSealevelScopedSalt(other, salt);
    expect([...a]).to.not.deep.equal([...b]);
  });

  it('matches keccak256(payer.toBytes() || clientSalt)', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const combined = new Uint8Array(32 + 32);
    combined.set(PAYER.toBytes(), 0);
    combined.set(salt, 32);
    const expected = hexToBytes(keccak256(combined));
    expect([...computeSealevelScopedSalt(PAYER, salt)]).to.deep.equal([
      ...expected,
    ]);
  });
});
