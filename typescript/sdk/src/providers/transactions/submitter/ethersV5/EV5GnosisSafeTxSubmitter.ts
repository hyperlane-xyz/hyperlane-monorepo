import { Logger } from 'pino';

import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

// prettier-ignore
// @ts-ignore
import { canProposeSafeTransactions, getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
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
    private safe: any,
    private safeService: any,
  ) {}

  static async create(
    multiProvider: MultiProvider,
    props: EV5GnosisSafeTxSubmitterProps,
  ): Promise<EV5GnosisSafeTxSubmitter> {
    const { chain, safeAddress } = props;
    const { gnosisSafeTransactionServiceUrl } =
      multiProvider.getChainMetadata(chain);
    assert(
      gnosisSafeTransactionServiceUrl,
      `Must set gnosisSafeTransactionServiceUrl in the Registry metadata for ${chain}`,
    );

    const signerAddress = await multiProvider.getSigner(chain).getAddress();
    const authorized = await canProposeSafeTransactions(
      signerAddress,
      chain,
      multiProvider,
      safeAddress,
    );
    assert(
      authorized,
      `Signer ${signerAddress} is not an authorized Safe Proposer for ${safeAddress}`,
    );

    const safe = await getSafe(chain, multiProvider, safeAddress);
    const safeService = await getSafeService(chain, multiProvider);

    return new EV5GnosisSafeTxSubmitter(
      multiProvider,
      props,
      safe,
      safeService,
    );
  }

  public async createSafeTransaction({
    to,
    data,
    value,
    chainId,
  }: PopulatedTransaction): Promise<any> {
    const nextNonce: number = await this.safeService.getNextNonce(
      this.props.safeAddress,
    );
    const txChain = this.multiProvider.getChainName(chainId);
    assert(
      txChain === this.props.chain,
      `Invalid PopulatedTransaction: Cannot submit ${txChain} tx to ${this.props.chain} submitter.`,
    );
    return this.safe.createTransaction({
      safeTransactionData: [{ to, data, value: value?.toString() ?? '0' }],
      options: { nonce: nextNonce },
    });
  }

  public async submit(...txs: PopulatedTransactions): Promise<any[]> {
    return Promise.all(
      txs.map(async (tx: PopulatedTransaction) => {
        const safeTransaction = await this.createSafeTransaction(tx);

        const safeTransactionData: any = safeTransaction.data;
        const safeTxHash: string = await this.safe.getTransactionHash(
          safeTransaction,
        );
        const senderAddress: Address =
          await this.multiProvider.getSignerAddress(this.props.chain);
        const safeSignature: any = await this.safe.signTransactionHash(
          safeTxHash,
        );
        const senderSignature: string = safeSignature.data;

        this.logger.info(
          `Submitting transaction proposal to ${this.props.safeAddress} on ${this.props.chain}: ${safeTxHash}`,
        );

        const transactionReceipts = await this.safeService.proposeTransaction({
          safeAddress: this.props.safeAddress,
          safeTransactionData,
          safeTxHash,
          senderAddress,
          senderSignature,
        });

        return transactionReceipts ?? [];
      }),
    );
  }
}
