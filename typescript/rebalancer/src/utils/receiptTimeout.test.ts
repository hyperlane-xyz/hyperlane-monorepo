import { expect } from 'chai';

import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  ReceiptWaitTimeoutError,
  isReceiptWaitTimeoutError,
  waitForReceiptWithTimeout,
} from './receiptTimeout.js';

describe('receiptTimeout', () => {
  it('uses a five-minute default receipt deadline', () => {
    expect(DEFAULT_RECEIPT_TIMEOUT_MS).to.equal(300_000);
  });

  it('returns a receipt that resolves before the deadline', async () => {
    const receipt = { status: 1 };

    const result = await waitForReceiptWithTimeout(Promise.resolve(receipt), {
      txHash: '0xreceipt',
      operation: 'test receipt',
    });

    expect(result).to.equal(receipt);
  });

  it('throws a typed error with transaction context on timeout', async () => {
    const neverResolves = new Promise<never>(() => undefined);

    try {
      await waitForReceiptWithTimeout(neverResolves, {
        txHash: '0xtimeout',
        operation: 'erc20 approve',
        timeoutMs: 1,
        role: 'approval',
      });
      expect.fail('Expected receipt wait to time out');
    } catch (error) {
      expect(isReceiptWaitTimeoutError(error)).to.equal(true);
      expect(error).to.be.instanceOf(ReceiptWaitTimeoutError);
      if (error instanceof ReceiptWaitTimeoutError) {
        expect(error.txHash).to.equal('0xtimeout');
        expect(error.operation).to.equal('erc20 approve');
        expect(error.timeoutMs).to.equal(1);
        expect(error.role).to.equal('approval');
      }
    }
  });

  it('preserves receipt errors from the provider', async () => {
    const providerError = new Error('transaction reverted');

    try {
      await waitForReceiptWithTimeout(Promise.reject(providerError), {
        txHash: '0xreverted',
        operation: 'test receipt',
      });
      expect.fail('Expected provider error');
    } catch (error) {
      expect(error).to.equal(providerError);
    }
  });

  it('rejects non-positive receipt deadlines', async () => {
    try {
      await waitForReceiptWithTimeout(Promise.resolve({ status: 1 }), {
        txHash: '0xreceipt',
        operation: 'test receipt',
        timeoutMs: 0,
      });
      expect.fail('Expected receipt timeout validation to fail');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.equal('Receipt timeout must be positive');
      }
    }
  });
});
