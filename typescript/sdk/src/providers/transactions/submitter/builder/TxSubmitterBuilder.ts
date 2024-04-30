import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import {
  TypedTransaction,
  TypedTransactionReceipt,
} from '../../../ProviderType.js';
import { TxTransformerInterface } from '../../transformer/TxTransformerInterface.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';

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

  constructor(
    private currentSubmitter: TxSubmitterInterface<TX, TR>,
    private readonly currentTransformers: TxTransformerInterface<TX>[] = [],
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
    this.currentTransformers.push(txTransformer);
    return this;
  }

  /**
   * Submits a set of transactions to the builder.
   * @param txs The transactions to submit
   */
  public async submit(...txs: TX[]): Promise<TR[]> {
    this.logger.info(
      `Submitting ${txs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter...`,
    );

    let transformedTxs = txs;
    while (this.currentTransformers.length > 0) {
      const currentTransformer: TxTransformerInterface<TX> =
        this.currentTransformers.pop()!;
      transformedTxs = await currentTransformer.transform(...transformedTxs);
      this.logger.info(
        `🔄 Transformed ${transformedTxs.length} transactions with the ${currentTransformer.txTransformerType} transformer...`,
      );
    }

    const txReceipts = await this.currentSubmitter.submit(...transformedTxs);
    this.logger.info(
      `✅ Successfully submitted ${transformedTxs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter.`,
    );

    return txReceipts ?? [];
  }
}
