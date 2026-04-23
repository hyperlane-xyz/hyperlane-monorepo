import { expect } from 'vitest';

import {
  addressToBytes,
  addressToBytes32,
  bytesToProtocolAddress,
  isAddressStarknet,
  isValidAddressStarknet,
  isZeroishAddress,
  padBytesToLength,
} from './addresses.js';
import { ProtocolType } from './types.js';

const ETH_ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const ETH_NON_ZERO_ADDR = '0x0000000000000000000000000000000000000001';
const COS_ZERO_ADDR = 'cosmos1000';
const COS_NON_ZERO_ADDR =
  'neutron1jyyjd3x0jhgswgm6nnctxvzla8ypx50tew3ayxxwkrjfxhvje6kqzvzudq';
const COSMOS_PREFIX = 'neutron';
const COSMOS_NATIVE_ZERO_ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const COSMOS_NATIVE_NON_ZERO_ADDR =
  '0x726f757465725f61707000000000000000000000000000010000000000000000';
const SOL_ZERO_ADDR = '111111';
const SOL_NON_ZERO_ADDR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const STARKNET_ZERO_ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const STARKNET_NON_ZERO_ADDR =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
const STARKNET_ADDRESSES = [
  // 65 characters (0x + 63 hex chars)
  '0x5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a53',
  // 66 characters (0x + 64 hex chars)
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  // 63 characters (no 0x prefix)
  '5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a53',
  // 64 characters (no 0x prefix)
  '049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
];

// TODO increase address utility test coverage
describe('Address utilities', () => {
  describe('isZeroishAddress', () => {
    it('Identifies 0-ish addresses', () => {
      expect(isZeroishAddress('0x')).toBe(true);
      expect(isZeroishAddress(ETH_ZERO_ADDR)).toBe(true);
      expect(isZeroishAddress(COS_ZERO_ADDR)).toBe(true);
      expect(isZeroishAddress(COSMOS_NATIVE_ZERO_ADDR)).toBe(true);
      expect(isZeroishAddress(SOL_ZERO_ADDR)).toBe(true);
      expect(isZeroishAddress(STARKNET_ZERO_ADDR)).toBe(true);
    });
    it('Identifies non-0-ish addresses', () => {
      expect(isZeroishAddress(ETH_NON_ZERO_ADDR)).toBe(false);
      expect(isZeroishAddress(COS_NON_ZERO_ADDR)).toBe(false);
      expect(isZeroishAddress(COSMOS_NATIVE_NON_ZERO_ADDR)).toBe(false);
      expect(isZeroishAddress(SOL_NON_ZERO_ADDR)).toBe(false);
      expect(isZeroishAddress(STARKNET_NON_ZERO_ADDR)).toBe(false);
    });
  });

  describe('addressToBytes', () => {
    it('Converts addresses to bytes', () => {
      expect(addressToBytes(ETH_NON_ZERO_ADDR).length).toBe(32);
      expect(addressToBytes(STARKNET_NON_ZERO_ADDR).length).toBe(32);
    });
    it('Rejects zeroish addresses', () => {
      expect(() => addressToBytes(ETH_ZERO_ADDR)).toThrow(Error);
      expect(() => addressToBytes(COS_ZERO_ADDR)).toThrow(Error);
      expect(() => addressToBytes(COSMOS_NATIVE_ZERO_ADDR)).toThrow(Error);
      expect(() => addressToBytes(SOL_ZERO_ADDR)).toThrow(Error);
      expect(() => addressToBytes(STARKNET_ZERO_ADDR)).toThrow(Error);
    });
  });

  describe('padBytesToLength', () => {
    it('Pads bytes to a given length', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(Array.from(padBytesToLength(bytes, 5))).toEqual([0, 0, 1, 2, 3]);
    });
    it('Rejects bytes that exceed the target length', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(() => padBytesToLength(bytes, 2)).toThrow(Error);
    });
  });

  describe('bytesToProtocolAddress', () => {
    it('Converts bytes to address', () => {
      expect(
        bytesToProtocolAddress(
          addressToBytes(ETH_NON_ZERO_ADDR),
          ProtocolType.Ethereum,
        ),
      ).toBe(ETH_NON_ZERO_ADDR);
      expect(
        bytesToProtocolAddress(
          addressToBytes(COSMOS_NATIVE_NON_ZERO_ADDR),
          ProtocolType.CosmosNative,
          COSMOS_PREFIX,
        ),
      ).toBe(COSMOS_NATIVE_NON_ZERO_ADDR);
      expect(
        bytesToProtocolAddress(
          addressToBytes(STARKNET_NON_ZERO_ADDR),
          ProtocolType.Starknet,
        ),
      ).toBe(STARKNET_NON_ZERO_ADDR);
    });
    it('Rejects zeroish addresses', () => {
      expect(() =>
        bytesToProtocolAddress(
          new Uint8Array([0, 0, 0]),
          ProtocolType.Ethereum,
        ),
      ).toThrow(Error);
    });
  });

  describe('isAddressStarknet', () => {
    it('Validates correct Starknet addresses', () => {
      for (const address of STARKNET_ADDRESSES) {
        expect(isAddressStarknet(address)).toBe(true);
      }
    });

    it('Rejects EVM addresses', () => {
      const evmAddress = '0x67C6390e8782b0B4F913f4dA99c065238Fb7DB30';
      expect(isAddressStarknet(evmAddress)).toBe(false);
    });

    it('Rejects addresses exceeding felt252 bounds', () => {
      const outOfBoundsAddress =
        '0x5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a530';
      expect(isAddressStarknet(outOfBoundsAddress)).toBe(false);
    });
  });

  describe('addressToBytes32', () => {
    it('Converts a base58 Solana address to bytes32 hex', () => {
      // mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X
      const solAddress = 'mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X';
      const result = addressToBytes32(solAddress);
      expect(result).toBe(
        '0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794',
      );
    });
    it('Converts an EVM address to bytes32 hex', () => {
      const result = addressToBytes32(ETH_NON_ZERO_ADDR);
      expect(result).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      );
    });
    it('Returns an already-bytes32 hex address unchanged', () => {
      const bytes32 =
        '0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794';
      expect(addressToBytes32(bytes32)).toBe(bytes32);
    });
  });

  describe('isValidAddressStarknet', () => {
    it('Validates correct Starknet addresses', () => {
      for (const address of STARKNET_ADDRESSES) {
        expect(isValidAddressStarknet(address)).toBe(true);
      }
    });

    it('Rejects EVM addresses', () => {
      const evmAddress = '0x67C6390e8782b0B4F913f4dA99c065238Fb7DB30';
      expect(isValidAddressStarknet(evmAddress)).toBe(false);
    });

    it('Rejects addresses exceeding felt252 bounds', () => {
      const outOfBoundsAddress =
        '0x5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a530';
      expect(isValidAddressStarknet(outOfBoundsAddress)).toBe(false);
    });
  });
});
