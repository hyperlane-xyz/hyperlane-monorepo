import { expect } from 'chai';
import { ethers } from 'ethers';

import { isInitialized, proxyAdmin, proxyAdminUpdateTxs } from './proxy.js';

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

  describe('proxyAdminUpdateTxs', () => {
    const CHAIN_ID = 1;
    const PROXY_ADDRESS = '0x1234567890123456789012345678901234567890';
    const PROXY_ADMIN_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const OWNER_A = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const OWNER_B = '0xcccccccccccccccccccccccccccccccccccccccc';
    const OWNER_C = '0xdddddddddddddddddddddddddddddddddddddddd';

    it('should use ownerOverrides.proxyAdmin over top-level owner when proxyAdmin config is not set', () => {
      const txs = proxyAdminUpdateTxs(
        CHAIN_ID,
        PROXY_ADDRESS,
        {
          owner: OWNER_A,
          proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner: OWNER_A },
        },
        { owner: OWNER_A, ownerOverrides: { proxyAdmin: OWNER_B } },
      );
      expect(txs.length).to.equal(1);
      expect(txs[0].annotation).to.include(OWNER_B);
    });

    it('should use ownerOverrides.proxyAdmin over proxyAdmin.owner when both are set', () => {
      const txs = proxyAdminUpdateTxs(
        CHAIN_ID,
        PROXY_ADDRESS,
        {
          owner: OWNER_A,
          proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner: OWNER_A },
        },
        {
          owner: OWNER_A,
          ownerOverrides: { proxyAdmin: OWNER_B },
          proxyAdmin: { owner: OWNER_C },
        },
      );
      expect(txs.length).to.equal(1);
      expect(txs[0].annotation).to.include(OWNER_B);
    });

    it('should return empty array when owners match via ownerOverrides', () => {
      const txs = proxyAdminUpdateTxs(
        CHAIN_ID,
        PROXY_ADDRESS,
        {
          owner: OWNER_A,
          proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner: OWNER_A },
        },
        { owner: OWNER_B, ownerOverrides: { proxyAdmin: OWNER_A } },
      );
      expect(txs.length).to.equal(0);
    });

    it('should fall back to top-level owner when no proxyAdmin config or ownerOverrides', () => {
      const txs = proxyAdminUpdateTxs(
        CHAIN_ID,
        PROXY_ADDRESS,
        {
          owner: OWNER_A,
          proxyAdmin: { address: PROXY_ADMIN_ADDRESS, owner: OWNER_A },
        },
        { owner: OWNER_B },
      );
      expect(txs.length).to.equal(1);
      expect(txs[0].annotation).to.include(OWNER_B);
    });
  });
});
