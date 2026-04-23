import { utils } from 'ethers';
import { expect } from 'vitest';

import { canonizeId, evmId } from './ids.js';

describe('ID Utilities', () => {
  describe('canonizeId', () => {
    it('should convert a 20-byte ID to a 32-byte ID', () => {
      const id = '0x1234567890123456789012345678901234567890';
      const result = canonizeId(id);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
      expect(utils.hexlify(result)).toBe(
        '0x0000000000000000000000001234567890123456789012345678901234567890',
      );
    });

    it('should throw an error for IDs longer than 32 bytes', () => {
      const id = '0x' + '12'.repeat(33);
      expect(() => canonizeId(id)).toThrow('Too long');
    });

    it('should throw an error for IDs not 20 or 32 bytes', () => {
      const id = '0x1234567890';
      expect(() => canonizeId(id)).toThrow(
        'bad input, expect address or bytes32',
      );
    });
  });

  describe('evmId', () => {
    it('should convert a 32-byte ID to a 20-byte EVM address', () => {
      const id =
        '0x' + '00'.repeat(12) + '1234567890123456789012345678901234567890';
      const result = evmId(id);
      expect(result).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should return the same 20-byte ID as a 20-byte EVM address', () => {
      const id = '0x1234567890123456789012345678901234567890';
      const result = evmId(id);
      expect(result).toBe(id);
    });

    it('should throw an error for IDs not 20 or 32 bytes', () => {
      const id = '0x1234567890';
      expect(() => evmId(id)).toThrow(
        'Invalid id length. expected 20 or 32. Got 5',
      );
    });
  });
});
