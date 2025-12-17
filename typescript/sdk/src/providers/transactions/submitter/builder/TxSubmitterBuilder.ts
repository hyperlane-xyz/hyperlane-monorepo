import { type Logger } from 'pino';

import {
  type Annotated,
  type ProtocolType,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  type ProtocolTypedReceipt,
  type ProtocolTypedTransaction,
} from '../../../ProviderType.js';
import { type TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { type TxSubmitterType } from '../TxSubmitterTypes.js';

/**
 * Builds a TxSubmitterBuilder for batch transaction submission.
 *
 * Example use-cases:
 *  const eV5builder = new TxSubmitterBuilder<EV5Transaction, EV5TransactionReceipt>();
 *  let txReceipts = eV5builder.for(
 *    new EV5GnosisSafeTxSubmitter(chainA)
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

  constructor(private currentSubmitter: TxSubmitterInterface<TProtocol>) {
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

    const txReceipts = await this.currentSubmitter.submit(...txs);
    this.logger.debug(
      `✅ Successfully submitted ${txs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter.`,
    );

    return txReceipts;
  }
}
