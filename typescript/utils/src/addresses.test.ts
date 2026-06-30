import { expect } from 'chai';

import {
  addressToBytes,
  addressToBytes32,
  addressToBytesTron,
  bytesToAddressTron,
  bytesToProtocolAddress,
  isAddressStarknet,
  isValidAddressStarknet,
  isZeroishAddress,
  normalizeAddressEvm,
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
      expect(isZeroishAddress('0x')).to.be.true;
      expect(isZeroishAddress(ETH_ZERO_ADDR)).to.be.true;
      expect(isZeroishAddress(COS_ZERO_ADDR)).to.be.true;
      expect(isZeroishAddress(COSMOS_NATIVE_ZERO_ADDR)).to.be.true;
      expect(isZeroishAddress(SOL_ZERO_ADDR)).to.be.true;
      expect(isZeroishAddress(STARKNET_ZERO_ADDR)).to.be.true;
    });
    it('Identifies non-0-ish addresses', () => {
      expect(isZeroishAddress(ETH_NON_ZERO_ADDR)).to.be.false;
      expect(isZeroishAddress(COS_NON_ZERO_ADDR)).to.be.false;
      expect(isZeroishAddress(COSMOS_NATIVE_NON_ZERO_ADDR)).to.be.false;
      expect(isZeroishAddress(SOL_NON_ZERO_ADDR)).to.be.false;
      expect(isZeroishAddress(STARKNET_NON_ZERO_ADDR)).to.be.false;
    });
  });

  describe('addressToBytes', () => {
    it('Converts addresses to bytes', () => {
      expect(addressToBytes(ETH_NON_ZERO_ADDR).length).to.equal(32);
      expect(addressToBytes(STARKNET_NON_ZERO_ADDR).length).to.equal(32);
    });
    it('Rejects zeroish addresses', () => {
      expect(() => addressToBytes(ETH_ZERO_ADDR)).to.throw(Error);
      expect(() => addressToBytes(COS_ZERO_ADDR)).to.throw(Error);
      expect(() => addressToBytes(COSMOS_NATIVE_ZERO_ADDR)).to.throw(Error);
      expect(() => addressToBytes(SOL_ZERO_ADDR)).to.throw(Error);
      expect(() => addressToBytes(STARKNET_ZERO_ADDR)).to.throw(Error);
    });
  });

  describe('padBytesToLength', () => {
    it('Pads bytes to a given length', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(Array.from(padBytesToLength(bytes, 5))).to.deep.equal([
        0, 0, 1, 2, 3,
      ]);
    });
    it('Rejects bytes that exceed the target length', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      expect(() => padBytesToLength(bytes, 2)).to.throw(Error);
    });
  });

  describe('bytesToProtocolAddress', () => {
    it('Converts bytes to address', () => {
      expect(
        bytesToProtocolAddress(
          addressToBytes(ETH_NON_ZERO_ADDR),
          ProtocolType.Ethereum,
        ),
      ).to.equal(ETH_NON_ZERO_ADDR);
      expect(
        bytesToProtocolAddress(
          addressToBytes(COSMOS_NATIVE_NON_ZERO_ADDR),
          ProtocolType.CosmosNative,
          COSMOS_PREFIX,
        ),
      ).to.equal(COSMOS_NATIVE_NON_ZERO_ADDR);
      expect(
        bytesToProtocolAddress(
          addressToBytes(STARKNET_NON_ZERO_ADDR),
          ProtocolType.Starknet,
        ),
      ).to.equal(STARKNET_NON_ZERO_ADDR);
    });
    it('Rejects zeroish addresses', () => {
      expect(() =>
        bytesToProtocolAddress(
          new Uint8Array([0, 0, 0]),
          ProtocolType.Ethereum,
        ),
      ).to.throw(Error);
    });
  });

  describe('isAddressStarknet', () => {
    it('Validates correct Starknet addresses', () => {
      for (const address of STARKNET_ADDRESSES) {
        expect(isAddressStarknet(address)).to.be.true;
      }
    });

    it('Rejects EVM addresses', () => {
      const evmAddress = '0x67C6390e8782b0B4F913f4dA99c065238Fb7DB30';
      expect(isAddressStarknet(evmAddress)).to.be.false;
    });

    it('Rejects addresses exceeding felt252 bounds', () => {
      const outOfBoundsAddress =
        '0x5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a530';
      expect(isAddressStarknet(outOfBoundsAddress)).to.be.false;
    });
  });

  describe('addressToBytes32', () => {
    it('Converts a base58 Solana address to bytes32 hex', () => {
      // mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X
      const solAddress = 'mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X';
      const result = addressToBytes32(solAddress);
      expect(result).to.equal(
        '0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794',
      );
    });
    it('Converts an EVM address to bytes32 hex', () => {
      const result = addressToBytes32(ETH_NON_ZERO_ADDR);
      expect(result).to.equal(
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      );
    });
    it('Returns an already-bytes32 hex address unchanged', () => {
      const bytes32 =
        '0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794';
      expect(addressToBytes32(bytes32)).to.equal(bytes32);
    });
  });

  describe('isValidAddressStarknet', () => {
    it('Validates correct Starknet addresses', () => {
      for (const address of STARKNET_ADDRESSES) {
        expect(isValidAddressStarknet(address)).to.be.true;
      }
    });

    it('Rejects EVM addresses', () => {
      const evmAddress = '0x67C6390e8782b0B4F913f4dA99c065238Fb7DB30';
      expect(isValidAddressStarknet(evmAddress)).to.be.false;
    });

    it('Rejects addresses exceeding felt252 bounds', () => {
      const outOfBoundsAddress =
        '0x5ab3ac43afd012da5037f72691f9791a9fd610900c0a1d6c18d41367aee9a530';
      expect(isValidAddressStarknet(outOfBoundsAddress)).to.be.false;
    });
  });

  describe('bytesToAddressTron / addressToBytesTron', () => {
    // Known Tron mainnet zero address (0x41 prefix + 20 zero bytes, base58check encoded)
    const TRON_ZERO_ADDR = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    const ZERO_20 = new Uint8Array(20);
    // Arbitrary 20-byte payload used for 0x44 tests
    const SAMPLE_20 = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);

    describe('0x41 (Tron mainnet)', () => {
      it('encodes 20 zero bytes to the known Tron zero address', () => {
        expect(bytesToAddressTron(ZERO_20, 0x41)).to.equal(TRON_ZERO_ADDR);
      });

      it('decodes the Tron zero address back to 20 zero bytes', () => {
        expect(
          Array.from(addressToBytesTron(TRON_ZERO_ADDR, 0x41)),
        ).to.deep.equal(Array.from(ZERO_20));
      });

      it('round-trips arbitrary 20-byte payload', () => {
        const addr = bytesToAddressTron(SAMPLE_20, 0x41);
        expect(Array.from(addressToBytesTron(addr, 0x41))).to.deep.equal(
          Array.from(SAMPLE_20),
        );
      });
    });

    describe('0x44 (Ultima mainnet)', () => {
      it('round-trips arbitrary 20-byte payload', () => {
        const addr = bytesToAddressTron(SAMPLE_20, 0x44);
        expect(Array.from(addressToBytesTron(addr, 0x44))).to.deep.equal(
          Array.from(SAMPLE_20),
        );
      });

      it('produces a different address than 0x41 for the same bytes', () => {
        const addr41 = bytesToAddressTron(SAMPLE_20, 0x41);
        const addr44 = bytesToAddressTron(SAMPLE_20, 0x44);
        expect(addr44).not.to.equal(addr41);
      });

      it('does not start with T', () => {
        const addr = bytesToAddressTron(SAMPLE_20, 0x44);
        expect(addr.startsWith('T')).to.be.false;
      });

      it('throws on prefix mismatch when decoding', () => {
        const addr44 = bytesToAddressTron(SAMPLE_20, 0x44);
        expect(() => addressToBytesTron(addr44, 0x41)).to.throw(
          'Tron address prefix mismatch',
        );
      });

      it('throws if 0x41 address is decoded with 0x44', () => {
        expect(() => addressToBytesTron(TRON_ZERO_ADDR, 0x44)).to.throw(
          'Tron address prefix mismatch',
        );
      });
    });
  });

  describe('normalizeAddressEvm', () => {
    // Run-1 ICA strategy incident: correct hex digits, bad EIP-55 casing.
    const BAD_CHECKSUM = '0x3f13C1351aC66CA0f4827c607A94C93C82AD0913';
    const CANONICAL = '0x3f13C1351AC66ca0f4827c607a94c93c82AD0913';

    it('Canonicalizes an address with a bad EIP-55 checksum', () => {
      expect(normalizeAddressEvm(BAD_CHECKSUM)).to.equal(CANONICAL);
    });

    it('Canonicalizes an all-lowercase address', () => {
      expect(normalizeAddressEvm(CANONICAL.toLowerCase())).to.equal(CANONICAL);
    });

    it('Leaves an already-canonical address unchanged', () => {
      expect(normalizeAddressEvm(CANONICAL)).to.equal(CANONICAL);
    });

    it('Returns zeroish addresses unchanged', () => {
      expect(normalizeAddressEvm(ETH_ZERO_ADDR)).to.equal(ETH_ZERO_ADDR);
    });

    it('Returns non-EVM input unchanged', () => {
      expect(normalizeAddressEvm(SOL_NON_ZERO_ADDR)).to.equal(
        SOL_NON_ZERO_ADDR,
      );
    });
  });
});
