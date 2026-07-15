import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ByteCursor } from './binary.js';
import {
  decodeSvmSignedQuote,
  encodeSvmSignedQuote,
  type SvmSignedQuote,
} from './fee.js';

describe('SvmSignedQuote codec', () => {
  it('round-trips a populated quote', () => {
    const original: SvmSignedQuote = {
      context: new Uint8Array([1, 2, 3, 4]),
      data: new Uint8Array([5, 6]),
      issuedAt: new Uint8Array([0, 0, 0, 1, 0, 0]),
      expiry: new Uint8Array([0, 0, 0, 2, 0, 0]),
      clientSalt: new Uint8Array(32).fill(7),
      signature: new Uint8Array(65).fill(8),
    };
    const decoded = decodeSvmSignedQuote(
      new ByteCursor(encodeSvmSignedQuote(original)),
    );
    expect(decoded).to.eql(original);
  });

  it('round-trips empty context and data', () => {
    const original: SvmSignedQuote = {
      context: new Uint8Array(),
      data: new Uint8Array(),
      issuedAt: new Uint8Array(6),
      expiry: new Uint8Array(6),
      clientSalt: new Uint8Array(32),
      signature: new Uint8Array(65),
    };
    const decoded = decodeSvmSignedQuote(
      new ByteCursor(encodeSvmSignedQuote(original)),
    );
    expect(decoded).to.eql(original);
  });

  for (const [field, len] of [
    ['issuedAt', 6],
    ['expiry', 6],
    ['clientSalt', 32],
    ['signature', 65],
  ] as const) {
    it(`encoder rejects ${field} with wrong length`, () => {
      const base: SvmSignedQuote = {
        context: new Uint8Array(),
        data: new Uint8Array(),
        issuedAt: new Uint8Array(6),
        expiry: new Uint8Array(6),
        clientSalt: new Uint8Array(32),
        signature: new Uint8Array(65),
      };
      const bad: SvmSignedQuote = { ...base, [field]: new Uint8Array(len - 1) };
      expect(() => encodeSvmSignedQuote(bad)).to.throw(
        new RegExp(`${field} must be ${len} bytes`),
      );
    });
  }
});
