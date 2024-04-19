import { TransactionReceipt } from '@ethersproject/providers';

import { HyperlaneTx } from '../../HyperlaneTx.js';
import { TxSubmitter } from '../TxSubmitter.js';

/**
 * Builds a TxSubmitter for batch transaction submission.
 */
export class TxSubmitterBuilder<HTX extends HyperlaneTx> {
  private txSubmitters: TxSubmitter[] = [];

  /**
   * Adds a TxSubmitter to the builder.
   * @param txSubmitter The TxSubmitter to add
   * @returns The TxSubmitterBuilder instance
   */
  public add(txSubmitter: TxSubmitter): TxSubmitterBuilder<HTX> {
    this.txSubmitters.push(txSubmitter);
    return this;
  }

  /**
   * Submits the Hyperlane transactions to the TxSubmitter.
   * @param hyperlaneTxs The Hyperlane transactions to submit
   * @returns The transaction receipts for the executed transactions
   */
  public async submitTxs(hyperlaneTxs: HTX[]): Promise<TransactionReceipt[]> {
    for (const txSubmitter of this.txSubmitters) {
      // TODO: Ensure the sendTxs() implementation is called iff that TxSubmitter supports the current HyperlaneTx type
      return await txSubmitter.sendTxs(hyperlaneTxs);
    }

    throw new Error(
      'No HyperlaneTxs list was empty. Cannot submit transactions to builder.',
    );
  }
}
