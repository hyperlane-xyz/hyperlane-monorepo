import { Logger } from 'pino';

import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

// @ts-ignore
import { getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { PopulatedTransaction, PopulatedTransactions } from '../../types.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';
import { EV5GnosisSafeTxSubmitterProps } from './types.js';

export class EV5GnosisSafeTxSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_SAFE;

  protected readonly logger: Logger = rootLogger.child({
    module: 'gnosis-safe-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EV5GnosisSafeTxSubmitterProps,
  ) {}

  public async submit(...txs: PopulatedTransactions): Promise<void> {
    const safe = await getSafe(
      this.props.chain,
      this.multiProvider,
      this.props.safeAddress,
    );
    const safeService = await getSafeService(
      this.props.chain,
      this.multiProvider,
    );
    const nextNonce: number = await safeService.getNextNonce(
      this.props.safeAddress,
    );
    const safeTransactionBatch: any[] = txs.map(
      ({ to, data, value, chainId }: PopulatedTransaction) => {
        const txChain = this.multiProvider.getChainName(chainId);
        assert(
          txChain === this.props.chain,
          `Invalid PopulatedTransaction: Cannot submit ${txChain} tx to ${this.props.chain} submitter.`,
        );
        return { to, data, value: value?.toString() ?? '0' };
      },
    );
    const safeTransaction = await safe.createTransaction({
      safeTransactionData: safeTransactionBatch,
      options: { nonce: nextNonce },
    });
    const safeTransactionData: any = safeTransaction.data;
    const safeTxHash: string = await safe.getTransactionHash(safeTransaction);
    const senderAddress: Address = await this.multiProvider.getSignerAddress(
      this.props.chain,
    );
    const safeSignature: any = await safe.signTransactionHash(safeTxHash);
    const senderSignature: string = safeSignature.data;

    this.logger.debug(
      `Submitting transaction proposal to ${this.props.safeAddress} on ${this.props.chain}: ${safeTxHash}`,
    );

    return safeService.proposeTransaction({
      safeAddress: this.props.safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
    });
  }
}
