import { TransactionReceipt } from '@ethersproject/providers';

import { GnosisSafeHyperlaneTx } from '../../GnosisSafeHyperlaneTx.js';
import { HyperlaneTx } from '../../HyperlaneTx.js';
import { ImpersonatedAccountHyperlaneTx } from '../../ImpersonatedAccountHyperlaneTx.js';
import { InterchainAccountHyperlaneTx } from '../../InterchainAccountHyperlaneTx.js';
import { SignerHyperlaneTx } from '../../SignerHyperlaneTx.js';
import { TxSubmitterInterface, TxSubmitterType } from '../TxSubmitter.js';

/**
 * Builds a TxSubmitter for batch transaction submission.
 */
export class TxSubmitterBuilder<HTX extends HyperlaneTx> {
  private txSubmitterRecords: Record<
    TxSubmitterType,
    TxSubmitterInterface<HTX>
  > = {} as Record<TxSubmitterType, TxSubmitterInterface<HTX>>;

  /**
   * Adds a TxSubmitter to the builder.
   * @param txSubmitter The TxSubmitter to add
   * @returns The TxSubmitterBuilder instance
   */
  public add(txSubmitter: TxSubmitterInterface<HTX>): TxSubmitterBuilder<HTX> {
    this.txSubmitterRecords[txSubmitter.txSubmitterType] = txSubmitter;
    return this;
  }

  /**
   * Submits the Hyperlane transactions to the TxSubmitter.
   * @param hyperlaneTxs The Hyperlane transactions to submit
   * @returns The transaction receipts for the executed transactions
   */
  public async submitTxs(
    ...hyperlaneTxSets: HTX[][]
  ): Promise<TransactionReceipt[]> {
    let transactionReceipts = [];
    for (const hyperlaneTxSet of hyperlaneTxSets) {
      let submitter: TxSubmitterInterface<HTX>;
      if (hyperlaneTxSet[0] instanceof SignerHyperlaneTx) {
        submitter = this.txSubmitterRecords[TxSubmitterType.SIGNER];
      } else if (hyperlaneTxSet[0] instanceof ImpersonatedAccountHyperlaneTx) {
        submitter =
          this.txSubmitterRecords[TxSubmitterType.IMPERSONATED_ACCOUNT];
      } else if (hyperlaneTxSet[0] instanceof GnosisSafeHyperlaneTx) {
        submitter = this.txSubmitterRecords[TxSubmitterType.GNOSIS_SAFE];
      } else if (hyperlaneTxSet[0] instanceof InterchainAccountHyperlaneTx) {
        submitter = this.txSubmitterRecords[TxSubmitterType.GNOSIS_SAFE];
      } else continue;

      if (submitter)
        transactionReceipts.push(await submitter.sendTxs(hyperlaneTxSet));
    }

    transactionReceipts = transactionReceipts.flat();
    if (transactionReceipts.length > 0) return transactionReceipts;

    throw new Error(
      'Failed to submit transactions to builder. HyperlaneTxs list was likely empty, or no submitters were provided.',
    );
  }
}
