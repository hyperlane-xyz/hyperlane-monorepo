import { expect } from 'chai';

import type {
  TronSDKOptions,
  TronSDKReceipt,
  TronSDKTransaction,
} from '../utils/types.js';

describe('Tron SDK Types', () => {
  describe('TronSDKOptions', () => {
    it('should accept valid options', () => {
      const options: TronSDKOptions = {
        rpcUrls: ['https://api.trongrid.io'],
        chainId: 728126428,
      };
      expect(options.rpcUrls).to.have.length(1);
      expect(options.chainId).to.equal(728126428);
    });

    it('should accept multiple rpcUrls', () => {
      const options: TronSDKOptions = {
        rpcUrls: [
          'https://api.trongrid.io',
          'https://api.tronstack.io',
          'https://api.shasta.trongrid.io',
        ],
        chainId: 728126428,
      };
      expect(options.rpcUrls).to.have.length(3);
    });
  });

  describe('TronSDKTransaction', () => {
    it('should represent a transaction structure', () => {
      // Minimal mock of a TronWeb transaction
      const tx: TronSDKTransaction = {
        transaction: {
          txID: 'abc123def456',
          raw_data: {
            contract: [],
            ref_block_bytes: 'ab12',
            ref_block_hash: 'cd34ef56',
            expiration: Date.now() + 60000,
            timestamp: Date.now(),
          },
          raw_data_hex: '0a0200...',
        } as never, // Cast to avoid strict type checking on mock
      };
      expect(tx.transaction).to.exist;
    });

    it('should optionally include contractAddress', () => {
      const tx: TronSDKTransaction = {
        transaction: {
          txID: 'abc123def456',
          raw_data: {
            contract: [],
            ref_block_bytes: 'ab12',
            ref_block_hash: 'cd34ef56',
            expiration: Date.now() + 60000,
            timestamp: Date.now(),
          },
          raw_data_hex: '0a0200...',
        } as never,
        contractAddress: 'TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf',
      };
      expect(tx.contractAddress).to.equal('TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf');
    });
  });

  describe('TronSDKReceipt', () => {
    it('should represent a receipt structure', () => {
      const receipt: TronSDKReceipt = {
        txId: 'abc123def456789012345678901234567890123456789012345678901234',
        blockNumber: 12345,
        success: true,
      };
      expect(receipt.txId).to.have.length(60);
      expect(receipt.blockNumber).to.equal(12345);
      expect(receipt.success).to.be.true;
    });

    it('should handle optional contractAddress', () => {
      const receipt: TronSDKReceipt = {
        txId: 'abc123def456789012345678901234567890123456789012345678901234',
        blockNumber: 12345,
        success: true,
        contractAddress: 'TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf',
      };
      expect(receipt.contractAddress).to.equal(
        'TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf',
      );
    });

    it('should handle optional energy and bandwidth', () => {
      const receipt: TronSDKReceipt = {
        txId: 'abc123def456789012345678901234567890123456789012345678901234',
        blockNumber: 12345,
        success: true,
        energyUsed: 50000,
        bandwidthUsed: 265,
      };
      expect(receipt.energyUsed).to.equal(50000);
      expect(receipt.bandwidthUsed).to.equal(265);
    });
  });
});
