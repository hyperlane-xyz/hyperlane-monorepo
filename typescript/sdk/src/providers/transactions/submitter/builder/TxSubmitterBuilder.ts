import { Logger } from 'pino';

import { Annotated, rootLogger } from '@hyperlane-xyz/utils';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ProtocolTypedReceipt,
  ProtocolTypedTransaction,
} from '../../../ProviderType.js';
import { TxTransformerInterface } from '../../transformer/TxTransformerInterface.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

/**
 * Builds a TxSubmitterBuilder for batch transaction submission.
 *
 * Example use-cases:
 *  const eV5builder = new TxSubmitterBuilder<EV5Transaction, EV5TransactionReceipt>();
 *  let txReceipts = eV5builder.for(
 *    new EV5GnosisSafeTxSubmitter(chainA)
 *  ).transform(
 *    EV5InterchainAccountTxTransformer(chainB)
 *  ).submit(
 *    txs
 *  );
 *  txReceipts = eV5builder.for(
 *    new EV5ImpersonatedAccountTxSubmitter(chainA)
 *  ).submit(txs);
 *  txReceipts = eV5builder.for(
 *    new EV5JsonRpcTxSubmitter(chainC)
 *  ).submit(txs);
 */
export class TxSubmitterBuilder<TProtocol extends ProtocolType>
  implements TxSubmitterInterface<TProtocol>
{
  public readonly txSubmitterType: TxSubmitterType;

  protected readonly logger: Logger = rootLogger.child({
    module: 'submitter-builder',
  });

  constructor(
    private currentSubmitter: TxSubmitterInterface<TProtocol>,
    private currentTransformers: TxTransformerInterface<TProtocol>[] = [],
  ) {
    this.txSubmitterType = this.currentSubmitter.txSubmitterType;
  }

  /**
   * Sets the current submitter for the builder.
   * @param txSubmitterOrType The submitter to add to the builder
   */
  public for(
    txSubmitter: TxSubmitterInterface<TProtocol>,
  ): TxSubmitterBuilder<TProtocol> {
    this.currentSubmitter = txSubmitter;
    return this;
  }

  /**
   * Adds a transformer for the builder.
   * @param txTransformerOrType The transformer to add to the builder
   */
  public transform(
    ...txTransformers: TxTransformerInterface<TProtocol>[]
  ): TxSubmitterBuilder<TProtocol> {
    this.currentTransformers = txTransformers;
    return this;
  }

  /**
   * Submits a set of transactions to the builder.
   * @param txs The transactions to submit
   */
  public async submit(
    ...txs: Annotated<ProtocolTypedTransaction<TProtocol>['transaction']>[]
  ): Promise<
    | ProtocolTypedReceipt<TProtocol>['receipt']
    | ProtocolTypedReceipt<TProtocol>['receipt'][]
    | void
  > {
    this.logger.debug(
      `Submitting ${txs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter...`,
    );

    let transformedTxs = txs;
    for (const currentTransformer of this.currentTransformers) {
      transformedTxs = await currentTransformer.transform(...transformedTxs);
      this.logger.debug(
        `🔄 Transformed ${transformedTxs.length} transactions with the ${currentTransformer.txTransformerType} transformer...`,
      );
    }

    const txReceipts = await this.currentSubmitter.submit(...transformedTxs);
    this.logger.debug(
      `✅ Successfully submitted ${transformedTxs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter.`,
    );

    return txReceipts;
  }
}
