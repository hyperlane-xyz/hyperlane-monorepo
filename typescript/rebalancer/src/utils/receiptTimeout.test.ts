import { expect } from 'chai';
import { constants, providers, Wallet } from 'ethers';
import sinon from 'sinon';

import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  ReceiptWaitTimeoutError,
  waitForReceiptWithTimeout,
} from './receiptTimeout.js';

const txHash = `0x${'a'.repeat(64)}`;
const receipt: providers.TransactionReceipt = {
  to: constants.AddressZero,
  from: constants.AddressZero,
  contractAddress: constants.AddressZero,
  transactionIndex: 0,
  gasUsed: constants.Zero,
  logsBloom: '0x',
  blockHash: txHash,
  transactionHash: txHash,
  logs: [],
  blockNumber: 1,
  confirmations: 1,
  cumulativeGasUsed: constants.Zero,
  effectiveGasPrice: constants.Zero,
  byzantium: true,
  type: 0,
  status: 1,
};

describe('receiptTimeout', () => {
  afterEach(() => sinon.restore());

  it('returns a confirmed receipt using the provider-owned five-minute deadline', async () => {
    const waitForTransaction = sinon.stub().resolves(receipt);
    expect(DEFAULT_RECEIPT_TIMEOUT_MS).to.equal(300_000);
    expect(
      await waitForReceiptWithTimeout(
        { waitForTransaction },
        { txHash, operation: 'test' },
      ),
    ).to.equal(receipt);
    expect(
      waitForTransaction.calledOnceWithExactly(
        txHash,
        1,
        DEFAULT_RECEIPT_TIMEOUT_MS,
      ),
    ).to.equal(true);
  });

  it('removes transaction listeners after repeated provider timeouts', async () => {
    const provider = new providers.StaticJsonRpcProvider('http://localhost:1', {
      name: 'test',
      chainId: 1,
    });
    sinon
      .stub(provider, 'perform')
      .withArgs('getTransactionReceipt')
      .resolves(null);
    sinon.stub(provider, 'poll').resolves();
    for (let attempt = 0; attempt < 3; attempt++) {
      let caught: unknown;
      try {
        await waitForReceiptWithTimeout(provider, {
          txHash,
          operation: 'approve',
          role: 'approval',
          timeoutMs: 5,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(ReceiptWaitTimeoutError);
      if (caught instanceof ReceiptWaitTimeoutError) {
        expect(caught.txHash).to.equal(txHash);
        expect(caught.role).to.equal('approval');
        expect(caught.timeoutMs).to.equal(5);
      }
      expect(provider.listenerCount(txHash)).to.equal(0);
      expect(provider.listenerCount('block')).to.equal(0);
    }
    provider.polling = false;
  });

  it('cleans replacement listeners through the original transaction waiter', async () => {
    const provider = new providers.StaticJsonRpcProvider('http://localhost:1', {
      name: 'test',
      chainId: 1,
    });
    sinon
      .stub(provider, 'perform')
      .withArgs('getTransactionReceipt')
      .resolves(null);
    sinon.stub(provider, 'poll').resolves();
    const transaction = provider._wrapTransaction(
      {
        hash: txHash,
        from: Wallet.createRandom().address,
        nonce: 0,
        gasLimit: constants.One,
        gasPrice: constants.One,
        data: '0x',
        value: constants.Zero,
        chainId: 1,
      },
      txHash,
      1,
    );
    let caught: unknown;
    try {
      await waitForReceiptWithTimeout(transaction, {
        txHash,
        operation: 'approve',
        timeoutMs: 5,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(ReceiptWaitTimeoutError);
    expect(provider.listenerCount(txHash)).to.equal(0);
    expect(provider.listenerCount('block')).to.equal(0);
    provider.polling = false;
  });

  it('preserves transaction replacement outcomes', async () => {
    const replacement = Object.assign(new Error('transaction was replaced'), {
      code: 'TRANSACTION_REPLACED',
      cancelled: false,
      receipt,
    });
    const wait = sinon.stub().rejects(replacement);
    let caught: unknown;
    try {
      await waitForReceiptWithTimeout(
        { wait },
        { txHash, operation: 'approve', timeoutMs: 50 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(replacement);
    expect(wait.calledOnceWithExactly(1, 50)).to.equal(true);
  });

  it('preserves provider errors and rejects reverted receipts', async () => {
    const providerError = new Error('RPC unavailable');
    const waitForTransaction = sinon.stub().rejects(providerError);
    let caught: unknown;
    try {
      await waitForReceiptWithTimeout(
        { waitForTransaction },
        { txHash, operation: 'test' },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(providerError);
    waitForTransaction.resolves({ ...receipt, status: 0 });
    try {
      await waitForReceiptWithTimeout(
        { waitForTransaction },
        { txHash, operation: 'test' },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    if (caught instanceof Error)
      expect(caught.message).to.include('transaction failed');
  });

  it('rejects non-positive deadlines without starting a waiter', async () => {
    const waitForTransaction = sinon.stub();
    let caught: unknown;
    try {
      await waitForReceiptWithTimeout(
        { waitForTransaction },
        { txHash, operation: 'test', timeoutMs: 0 },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(waitForTransaction.called).to.equal(false);
  });
});
