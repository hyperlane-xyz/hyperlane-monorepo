import { beforeAll, describe, expect, it } from 'vitest';

import { AccountRole, address as parseAddress } from '@solana/kit';

import { DEFAULT_COMPUTE_UNITS, LAMPORTS_PER_SIGNATURE } from '../constants.js';
import { SvmProvider } from '../clients/provider.js';
import type { SvmTransaction } from '../types.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';

describe('SVM Provider E2E Tests', () => {
  let provider: SvmProvider;

  beforeAll(async () => {
    provider = await SvmProvider.connect(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      String(TEST_SVM_CHAIN_METADATA.domainId),
    );
  });

  describe('estimateTransactionFee', () => {
    it('should return the base fee per signature from the RPC', async () => {
      const tx: SvmTransaction = { instructions: [] };
      const result = await provider.estimateTransactionFee({
        transaction: tx,
      });

      expect(result.gasPrice).toBe(LAMPORTS_PER_SIGNATURE);
      expect(result.fee).toBe(BigInt(LAMPORTS_PER_SIGNATURE));
      expect(result.gasUnits).toBe(BigInt(DEFAULT_COMPUTE_UNITS));
    });

    it('should scale fee by number of signers', async () => {
      const mockSigner = {
        address: '6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt',
      };
      const tx: SvmTransaction = {
        instructions: [],
        additionalSigners: [mockSigner as any],
      };
      const result = await provider.estimateTransactionFee({
        transaction: tx,
      });

      // 1 fee payer + 1 additional signer = 2 signers
      expect(result.fee).toBe(BigInt(2) * BigInt(result.gasPrice));
    });

    it('should count signers from instruction account metas', async () => {
      const tx: SvmTransaction = {
        instructions: [
          {
            programAddress: parseAddress('11111111111111111111111111111111'),
            accounts: [
              {
                address: parseAddress(
                  '6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt',
                ),
                role: AccountRole.WRITABLE_SIGNER,
              },
              {
                address: parseAddress(
                  '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
                ),
                role: AccountRole.READONLY_SIGNER,
              },
              {
                address: parseAddress(
                  '6NQxNKjqG7nybhudHzvdU3qhkb6pJjCpTX1zuqw6DhU8',
                ),
                role: AccountRole.WRITABLE,
              },
            ],
          },
        ],
      };
      const result = await provider.estimateTransactionFee({
        transaction: tx,
      });

      // 2 signers from instruction metas + 1 fee payer = 3
      expect(result.fee).toBe(BigInt(3) * BigInt(result.gasPrice));
    });

    it('should use custom compute units when specified', async () => {
      const customUnits = 200_000;
      const tx: SvmTransaction = {
        instructions: [],
        computeUnits: customUnits,
      };
      const result = await provider.estimateTransactionFee({
        transaction: tx,
      });

      expect(result.gasUnits).toBe(BigInt(customUnits));
    });
  });
});
