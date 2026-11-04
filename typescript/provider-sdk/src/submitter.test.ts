import { expect } from 'chai';
import { retryAsync } from '@hyperlane-xyz/utils';

import type { AnnotatedTx, TxReceipt } from './module.js';
import {
  AltVMJsonRpcSubmissionError,
  AltVMJsonRpcSubmitter,
} from './submitter.js';
import { MockSigner } from './test/AltVMMockSigner.js';

class RecordingSigner extends MockSigner {
  readonly attempted: AnnotatedTx[] = [];
  readonly receipts: TxReceipt[] = [];
  readonly failure = new Error('Confirmation unavailable');
  batching = false;
  failAt = 1;

  override supportsTransactionBatching(): boolean {
    return this.batching;
  }

  override async sendAndConfirmTransaction(
    tx: AnnotatedTx,
  ): Promise<TxReceipt> {
    this.attempted.push(tx);
    if (this.attempted.length - 1 === this.failAt) throw this.failure;
    const receipt = { transactionHash: `confirmed-${this.attempted.length}` };
    this.receipts.push(receipt);
    return receipt;
  }

  override async sendAndConfirmBatchTransactions(
    txs: AnnotatedTx[],
  ): Promise<TxReceipt> {
    this.attempted.push(...txs);
    throw this.failure;
  }
}

describe('AltVM JSON-RPC submission progress', () => {
  it('retains confirmed receipts and attempted inputs without admitting later sends', async () => {
    const signer = new RecordingSigner();
    const submitter = new AltVMJsonRpcSubmitter(signer, { chain: 'testchain' });
    const transactions = [
      { data: 'first' },
      { data: 'unknown' },
      { data: 'unstarted' },
    ];
    const result = await Promise.allSettled([
      retryAsync(async () => submitter.submit(...transactions), 3, 0),
    ]);
    const [outcome] = result;
    expect(outcome.status).to.equal('rejected');
    if (outcome.status !== 'rejected') throw new Error('Expected failed batch');
    const failure: unknown = outcome.reason;
    if (!(failure instanceof AltVMJsonRpcSubmissionError))
      throw new Error('Missing progress error');
    expect(failure.confirmedReceipts).to.deep.equal(signer.receipts);
    expect(failure.confirmedReceipts).to.have.length(1);
    expect(failure.attemptedTransactions).to.deep.equal(
      transactions.slice(0, 2),
    );
    expect(failure.cause).to.equal(signer.failure);
    expect(signer.attempted).to.deep.equal(transactions.slice(0, 2));
  });

  it('identifies a failed atomic batch as attempted without inventing receipts', async () => {
    const signer = new RecordingSigner();
    signer.batching = true;
    const transactions = [{ data: 'first' }, { data: 'second' }];
    const [outcome] = await Promise.allSettled([
      new AltVMJsonRpcSubmitter(signer, { chain: 'testchain' }).submit(
        ...transactions,
      ),
    ]);
    if (outcome.status !== 'rejected') throw new Error('Expected failed batch');
    const failure: unknown = outcome.reason;
    if (!(failure instanceof AltVMJsonRpcSubmissionError))
      throw new Error('Missing progress error');
    expect(failure.confirmedReceipts).to.deep.equal([]);
    expect(failure.attemptedTransactions).to.deep.equal(transactions);
    expect(failure.cause).to.equal(signer.failure);
  });

  it('preserves successful and empty submission results', async () => {
    const signer = new RecordingSigner();
    signer.failAt = -1;
    const submitter = new AltVMJsonRpcSubmitter(signer, { chain: 'testchain' });
    expect(await submitter.submit()).to.deep.equal([]);
    const transactions = [{ data: 'first' }, { data: 'second' }];
    expect(await submitter.submit(...transactions)).to.deep.equal(
      signer.receipts,
    );
    expect(signer.receipts).to.have.length(2);
    expect(submitter.txSubmitterType).to.equal('jsonRPC');
  });
});
