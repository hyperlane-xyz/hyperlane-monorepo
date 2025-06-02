import {
  OperationType,
  SafeTransaction,
} from '@safe-global/safe-core-sdk-types';
import { Logger } from 'pino';

import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

// prettier-ignore
// @ts-ignore
import { canProposeSafeTransactions, getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
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

  public async createSafeTransaction(
    ...transactions: AnnotatedEV5Transaction[]
  ): Promise<SafeTransaction> {
    const nextNonce: number = await this.safeService.getNextNonce(
      this.props.safeAddress,
    );
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);

    const safeTransactionData = transactions.map(
      ({ to, data, value, chainId }) => {
        assert(chainId, 'Invalid AnnotatedEV5Transaction: chainId is required');
        assert(
          chainId === submitterChainId,
          `Invalid AnnotatedEV5Transaction: Cannot submit tx for chain ID ${chainId} to submitter for chain ID ${submitterChainId}.`,
        );
        return { to, data, value: value?.toString() ?? '0' };
      },
    );

    const isMultiSend = transactions.length > 1;
    const safeTransaction = await this.safe.createTransaction({
      safeTransactionData,
      onlyCalls: isMultiSend,
      options: {
        nonce: nextNonce,
        operation: isMultiSend
          ? OperationType.DelegateCall
          : OperationType.Call,
      },
    });

    return safeTransaction;
  }

  public async submit(...txs: AnnotatedEV5Transaction[]): Promise<any> {
    const safeTransaction = await this.createSafeTransaction(...txs);
    return this.proposeSafeTransaction(safeTransaction);
  }

  private async proposeSafeTransaction(
    safeTransaction: SafeTransaction,
  ): Promise<void> {
    const safeTxHash: string =
      await this.safe.getTransactionHash(safeTransaction);
    const senderAddress: Address = await this.multiProvider.getSignerAddress(
      this.props.chain,
    );
    const safeSignature: any = await this.safe.signTypedData(safeTransaction);
    const senderSignature: string = safeSignature.data;

    this.logger.info(
      `Submitting transaction proposal to ${this.props.safeAddress} on ${this.props.chain}: ${safeTxHash}`,
    );

    return this.safeService.proposeTransaction({
      safeAddress: this.props.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature,
    });
  }
}
