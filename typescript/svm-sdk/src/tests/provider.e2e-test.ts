import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';

import { LAMPORTS_PER_SIGNATURE } from '../constants.js';
import { SvmProvider } from '../clients/provider.js';
import { DEFAULT_COMPUTE_UNITS } from '../tx.js';
import type { SvmTransaction } from '../types.js';
import {
  type SolanaTestValidator,
  startSolanaTestValidator,
  waitForRpcReady,
} from '../testing/solana-container.js';

describe('SVM Provider E2E Tests', function () {
  this.timeout(180_000);

  let solana: SolanaTestValidator;
  let provider: SvmProvider;

  before(async () => {
    solana = await startSolanaTestValidator();

    await waitForRpcReady(solana.rpcUrl);

    provider = await SvmProvider.connect([solana.rpcUrl], '1');
  });

  after(async () => {
    if (solana) {
      await solana.stop();
    }
  });

  describe('estimateTransactionFee', () => {
    it('should return the base fee per signature from the RPC', async () => {
      const tx: SvmTransaction = { instructions: [] };
      const result = await provider.estimateTransactionFee({
        transaction: tx,
      });

      expect(result.gasPrice).to.equal(LAMPORTS_PER_SIGNATURE);
      expect(result.fee).to.equal(BigInt(LAMPORTS_PER_SIGNATURE));
      expect(result.gasUnits).to.equal(BigInt(DEFAULT_COMPUTE_UNITS));
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
      expect(result.fee).to.equal(BigInt(2) * BigInt(result.gasPrice));
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

      expect(result.gasUnits).to.equal(BigInt(customUnits));
    });
  });
});
