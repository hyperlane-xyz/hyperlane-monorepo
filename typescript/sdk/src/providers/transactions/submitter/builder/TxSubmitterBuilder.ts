import { Logger } from 'pino';

import { Annotated, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import {
  ProtocolTypedReceipt,
  ProtocolTypedTransaction,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

/**
 * Builds a TxSubmitterBuilder for batch transaction submission.
 *
 * Example use-cases:
 *  const evmBuilder = new TxSubmitterBuilder<EthersV6Transaction, EthersV6TransactionReceipt>();
 *  let txReceipts = evmBuilder.for(
 *    new EvmGnosisSafeTxSubmitter(chainA)
 *  ).submit(
 *    txs
 *  );
 *  txReceipts = evmBuilder.for(
 *    new EvmImpersonatedAccountTxSubmitter(chainA)
 *  ).submit(txs);
 *  txReceipts = evmBuilder.for(
 *    new EvmJsonRpcTxSubmitter(chainC)
 *  ).submit(txs);
 */
export class TxSubmitterBuilder<
  TProtocol extends ProtocolType,
> implements TxSubmitterInterface<TProtocol> {
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
