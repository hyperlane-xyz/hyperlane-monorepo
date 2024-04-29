import assert from 'assert';
import { Logger } from 'pino';
import { Stack } from 'stack-typescript';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TypedTransaction,
  TypedTransactionReceipt,
} from '../../../ProviderType.js';
import { TxTransformerInterface } from '../../transformer/TxTransformer.js';
import { TxSubmitterInterface } from '../TxSubmitter.js';

/**
 * Builds a TxSubmitterBuilder for batch transaction submission.
 *
 * Example use-cases:
 *  const eV5builder = new TxSubmitterBuilder<EV5Transaction, EV5TransactionReceipt>();
 *  let txReceipts = eV5builder.for(
 *    new GnosisSafeTxSubmitter(chainA)
 *  ).transform(
 *    InterchainAccountTxTransformer(chainB)
 *  ).submit(
 *    txs
 *  );
 *  txReceipts = eV5builder.for(
 *    new ImpersonatedAccountTxSubmitter(chainA)
 *  ).submit(txs);
 *  txReceipts = eV5builder.for(
 *    new JsonRpcTxSubmitter(chainC)
 *  ).submit(txs);
 */
export class TxSubmitterBuilder<
  TX extends TypedTransaction,
  TR extends TypedTransactionReceipt,
> {
  protected readonly logger: Logger = rootLogger.child({
    module: 'submitter-builder',
  });

  private currentSubmitter?: TxSubmitterInterface<TX, TR>;

  constructor(
    private readonly currentTransformers: Stack<
      TxTransformerInterface<TX>
    > = new Stack<TxTransformerInterface<TX>>(),
  ) {}

  /**
   * Sets the current submitter for the builder.
   * @param txSubmitterOrType The submitter to add to the builder
   */
  public for(
    txSubmitter: TxSubmitterInterface<TX, TR>,
  ): TxSubmitterBuilder<TX, TR> {
    this.currentSubmitter = txSubmitter;
    return this;
  }

  /**
   * Adds a transformer for the builder.
   * @param txTransformerOrType The transformer to add to the builder
   */
  public transform(
    txTransformer: TxTransformerInterface<TX>,
  ): TxSubmitterBuilder<TX, TR> {
    assert(
      this.currentSubmitter,
      'No submitter specified for which to execute the transform.',
    );

    this.currentTransformers.push(txTransformer);
    return this;
  }

  /**
   * Submits a set of transactions to the builder.
   * @param txs The transactions to submit
   */
  public async submit(txs: TX[]): Promise<TR[]> {
    assert(
      this.currentSubmitter,
      'Must specify submitter to submit transactions.',
    );

    this.logger.info(
      `Submitting ${txs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter...`,
    );

    let transformedTxs = txs;
    while (this.currentTransformers.size > 0) {
      const currentTransformer: TxTransformerInterface<TX> =
        this.currentTransformers.pop();
      transformedTxs = await currentTransformer.transformTxs(transformedTxs);
      this.logger.info(
        `🔄 Transformed ${transformedTxs.length} transactions with the ${currentTransformer.txTransformerType} transformer...`,
      );
    }

    const txReceipts = await this.currentSubmitter.submitTxs(transformedTxs);
    this.logger.info(
      `✅ Successfully submitted ${transformedTxs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter.`,
    );

    this.currentSubmitter = undefined;

    return txReceipts ?? [];
  }
}
