import { expect } from 'chai';

import { fromTronHex, toTronHex, tronAddressToHex } from './index.js';

// Tron mainnet zero address (0x41 prefix + 20 zero bytes)
const TRON_ZERO_B58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TRON_ZERO_HEX = '41' + '0'.repeat(40); // '41' + 40 hex zeros
const EVM_ZERO_ADDR = '0x' + '0'.repeat(40);

describe('tron-sdk utils', () => {
  describe('toTronHex', () => {
    it('prepends 0x41 by default', () => {
      expect(toTronHex(EVM_ZERO_ADDR)).to.equal(TRON_ZERO_HEX);
    });

    it('prepends custom prefix for Ultima (0x44)', () => {
      const prefix = '44';
      expect(toTronHex(EVM_ZERO_ADDR, prefix)).to.equal('44' + '0'.repeat(40));
    });

    it('strips 0x before prepending prefix', () => {
      const evm = '0xabcdef1234567890abcdef1234567890abcdef12';
      const hex = strip0x(evm);
      expect(toTronHex(evm, '41')).to.equal('41' + hex);
      expect(toTronHex(evm, '44')).to.equal('44' + hex);
    });
  });

  describe('tronAddressToHex', () => {
    it('converts 0x EVM address with default 0x41 prefix', () => {
      expect(tronAddressToHex(EVM_ZERO_ADDR)).to.equal(TRON_ZERO_HEX);
    });

    it('converts 0x EVM address with 0x44 prefix', () => {
      expect(tronAddressToHex(EVM_ZERO_ADDR, '44')).to.equal(
        '44' + '0'.repeat(40),
      );
    });

    it('converts base58 T-address to 0x41-prefixed hex', () => {
      const hex = tronAddressToHex(TRON_ZERO_B58, '41');
      expect(hex).to.equal(TRON_ZERO_HEX);
    });

    it('round-trips: tronAddressToHex → fromTronHex → tronAddressToHex', () => {
      const evmAddr = '0x1111222233334444555566667777888899990000';
      const hex41 = tronAddressToHex(evmAddr, '41');
      const hex44 = tronAddressToHex(evmAddr, '44');
      // fromTronHex decodes hex back to base58, then tronAddressToHex re-encodes
      expect(tronAddressToHex(fromTronHex(hex41), '41')).to.equal(hex41);
      expect(tronAddressToHex(fromTronHex(hex44), '44')).to.equal(hex44);
    });
  });

  describe('fromTronHex', () => {
    it('decodes 0x41-prefixed hex to the known Tron zero address', () => {
      expect(fromTronHex(TRON_ZERO_HEX)).to.equal(TRON_ZERO_B58);
    });

    it('decodes 0x44-prefixed hex to a different address than 0x41', () => {
      const hex41 = '41' + '1'.repeat(40);
      const hex44 = '44' + '1'.repeat(40);
      const addr41 = fromTronHex(hex41);
      const addr44 = fromTronHex(hex44);
      expect(addr41).not.to.equal(addr44);
      expect(addr41.startsWith('T')).to.be.true;
      expect(addr44.startsWith('T')).to.be.false;
    });

    it('round-trips with tronAddressToHex for 0x44 prefix', () => {
      const originalHex = '44' + 'ab'.repeat(20);
      const b58 = fromTronHex(originalHex);
      const backToHex = tronAddressToHex(b58, '44');
      expect(backToHex).to.equal(originalHex);
    });
  });
});

// inline helper (avoids importing strip0x twice in tests)
function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}
