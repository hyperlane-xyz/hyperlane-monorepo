import { expect } from 'chai';
import { ethers } from 'ethers';

import { isInitialized, proxyAdmin } from './proxy.js';

describe('proxy utilities', () => {
  describe('isInitialized', () => {
    it('should return false for empty hex string response (malformed RPC)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () => '', // Malformed: empty string
      } as any;

      const result = await isInitialized(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(false);
    });

    it('should return false for 0x response (malformed RPC)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () => '0x', // Malformed: empty hex
      } as any;

      const result = await isInitialized(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(false);
    });

    it('should return true for value of 1 (initialized)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () =>
          '0x0000000000000000000000000000000000000000000000000000000000000001',
      } as any;

      const result = await isInitialized(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(true);
    });

    it('should return true for value of 255 (initialized)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () =>
          '0x00000000000000000000000000000000000000000000000000000000000000ff',
      } as any;

      const result = await isInitialized(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(true);
    });

    it('should return false for value of 0 (not initialized)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () =>
          '0x0000000000000000000000000000000000000000000000000000000000000000',
      } as any;

      const result = await isInitialized(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(false);
    });
  });

  describe('proxyAdmin', () => {
    it('should return zero address for empty string response (malformed RPC)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () => '', // Malformed: empty string
      } as any;

      const result = await proxyAdmin(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(ethers.constants.AddressZero);
    });

    it('should return zero address for 0x response (malformed RPC)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () => '0x', // Malformed: empty hex
      } as any;

      const result = await proxyAdmin(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(ethers.constants.AddressZero);
    });

    it('should return zero address for 0x0 response (malformed RPC)', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () => '0x0', // Malformed: minimal hex
      } as any;

      const result = await proxyAdmin(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(ethers.constants.AddressZero);
    });

    it('should return valid address for proper storage value', async () => {
      const testAddress = '0x1234567890123456789012345678901234567890';
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () =>
          '0x0000000000000000000000001234567890123456789012345678901234567890', // Valid address in storage
      } as any;

      const result = await proxyAdmin(
        mockProvider,
        '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
      );
      expect(result.toLowerCase()).to.equal(testAddress.toLowerCase());
    });

    it('should return zero address for all-zero storage value', async () => {
      const mockProvider = {
        getCode: async () => '0x1234', // Has code
        getStorageAt: async () =>
          '0x0000000000000000000000000000000000000000000000000000000000000000', // All zeros
      } as any;

      const result = await proxyAdmin(
        mockProvider,
        '0x1234567890123456789012345678901234567890',
      );
      expect(result).to.equal(ethers.constants.AddressZero);
    });
  });
});
