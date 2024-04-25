import assert from 'assert';
import { Logger } from 'pino';

import { rootLogger } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { HyperlaneTx } from '../../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../../HyperlaneTxReceipt.js';
import { InterchainAccountTxTransformer } from '../../transformer/InterchainAccountTxTransformer.js';
import { TxTransformerInterface } from '../../transformer/TxTransformer.js';
import { TxTransformerType } from '../../transformer/TxTransformerTypes.js';
import { GnosisSafeTxSubmitter } from '../GnosisSafeTxSubmitter.js';
import { ImpersonatedAccountTxSubmitter } from '../ImpersonatedAccountTxSubmitter.js';
import { SignerTxSubmitter } from '../SignerTxSubmitter.js';
import { TxSubmitterInterface } from '../TxSubmitter.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import {
  TxSubmitterXORType,
  TxTransformerXORType,
} from './TxSubmitterBuilderTypes.js';

/**
 * Builds a TxSubmitterBuilder for batch transaction submission.
 *
 * Example use-cases:
 *  const builder = new TxSubmitterBuilder(mp);
 *  let txReceipts = builder.add(
 *    TxSubmitterType.GNOSIS_SAFE, chainA
 *  ).transform(
 *    TxSubmitterType.ICA, chainB
 *  ).submit(
 *    populatedTxs
 *  );
 *  txReceipts = builder.add(new ImpersonatedAccountTxSubmitter(chainA)).submit(populatedTxs);
 *  txReceipts = builder.add(TxSubmitterType.SIGNER, chainC).submit(populatedTxs);
 */
export class TxSubmitterBuilder<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> {
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  private currentSubmitter?: TxSubmitterInterface<HTX, HTR>;
  private currentTransformer?: TxTransformerInterface<HTX>;

  constructor(private readonly multiProvider: MultiProvider) {
    this.multiProvider = multiProvider;
  }

  /**
   * Sets the current submitter for the builder.
   * @param txSubmitterOrType The submitter to add to the builder
   */
  public add(
    txSubmitterOrType: TxSubmitterXORType<HTX, HTR>,
  ): TxSubmitterBuilder<HTX, HTR> {
    switch (txSubmitterOrType.type) {
      case TxSubmitterType.SIGNER:
        this.currentSubmitter = new SignerTxSubmitter<HTX, HTR>(
          this.multiProvider,
          txSubmitterOrType.chain,
        );
        return this;
      case TxSubmitterType.IMPERSONATED_ACCOUNT:
        assert(
          txSubmitterOrType.impersonatedAccountTxSubmitterProps,
          'Must provide required props for impersonated account submitter.',
        );
        this.currentSubmitter = new ImpersonatedAccountTxSubmitter<HTX, HTR>(
          this.multiProvider,
          txSubmitterOrType.chain,
          txSubmitterOrType.impersonatedAccountTxSubmitterProps,
        );
        return this;
      case TxSubmitterType.GNOSIS_SAFE:
        assert(
          txSubmitterOrType.gnosisSafeTxSubmitterProps,
          'Must provide required props for Gnosis safe submitter.',
        );
        this.currentSubmitter = new GnosisSafeTxSubmitter<HTX, HTR>(
          this.multiProvider,
          txSubmitterOrType.chain,
          txSubmitterOrType.gnosisSafeTxSubmitterProps,
        );
        return this;
      default:
        this.currentSubmitter = txSubmitterOrType.submitter;
        return this;
    }
  }

  /**
   * Sets the current transformer for the builder.
   * @param txTransformerOrType The transformer to add to the builder
   */
  public transform(
    txTransformerOrType: TxTransformerXORType<HTX>,
  ): TxSubmitterBuilder<HTX, HTR> {
    assert(
      this.currentSubmitter,
      'No submitter specified for which to execute the transform.',
    );

    switch (txTransformerOrType.type) {
      case TxTransformerType.ICA:
        assert(
          txTransformerOrType.interchainAccountTxTransformerProps,
          'Must provide required props for interchain account submitter.',
        );
        this.currentTransformer = new InterchainAccountTxTransformer<HTX>(
          this.multiProvider,
          this.currentSubmitter.chain,
          txTransformerOrType.chain,
          txTransformerOrType.interchainAccountTxTransformerProps,
        );
        return this;
      default:
        this.currentTransformer = txTransformerOrType.transformer;
        return this;
    }
  }

  /**
   * Submits a set of transactions to the builder.
   * @param hyperlaneTxs The transactions to submit
   */
  public async submit(hyperlaneTxs: HTX[]): Promise<HTR[]> {
    assert(
      this.currentSubmitter,
      'Must specify submitter to submit transactions.',
    );

    this.logger.info(
      `Submitting ${hyperlaneTxs.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter...`,
    );

    let transformedHyperlaneTxs = hyperlaneTxs;
    if (this.currentTransformer) {
      transformedHyperlaneTxs = await this.currentTransformer.transformTxs(
        hyperlaneTxs,
        this.currentSubmitter.txSubmitterType,
      );
      this.logger.info(
        `🔄 Transformed ${transformedHyperlaneTxs.length} transactions with the ${this.currentTransformer.txTransformerType} transformer...`,
      );
    }

    const hyperlaneTxReceipts = await this.currentSubmitter.submitTxs(
      transformedHyperlaneTxs,
    );
    this.logger.info(
      `✅ Successfully submitted ${hyperlaneTxReceipts.length} transactions to the ${this.currentSubmitter.txSubmitterType} submitter.`,
    );

    this.currentSubmitter = undefined;
    this.currentTransformer = undefined;

    return hyperlaneTxReceipts;
  }
}
