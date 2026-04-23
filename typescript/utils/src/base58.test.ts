import { utils } from 'ethers';
import { expect } from 'vitest';

import { base58ToBuffer, bufferToBase58, hexOrBase58ToHex } from './base58.js';

describe('Base58 Utilities', () => {
  describe('base58ToBuffer', () => {
    it('should convert a base58 string to a buffer', () => {
      const base58String = '3mJr7AoUXx2Wqd';
      const expectedBuffer = Buffer.from(utils.base58.decode(base58String));
      expect(base58ToBuffer(base58String)).toEqual(expectedBuffer);
    });
  });

  describe('bufferToBase58', () => {
    it('should convert a buffer to a base58 string', () => {
      const buffer = Buffer.from([1, 2, 3, 4]);
      const expectedBase58String = utils.base58.encode(buffer);
      expect(bufferToBase58(buffer)).toBe(expectedBase58String);
    });
  });

  describe('hexOrBase58ToHex', () => {
    it('should return the hex string as is if it starts with 0x', () => {
      const hexString = '0x1234abcd';
      expect(hexOrBase58ToHex(hexString)).toBe(hexString);
    });

    it('should convert a base58 string to a hex string', () => {
      const base58String = '3mJr7AoUXx2Wqd';
      const expectedHexString = utils.hexlify(
        Buffer.from(utils.base58.decode(base58String)),
      );
      expect(hexOrBase58ToHex(base58String)).toBe(expectedHexString);
    });
  });
});
