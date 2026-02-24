import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import {
  MetaTransactionData,
  SafeTransaction,
} from '@safe-global/safe-core-sdk-types';
import { Logger } from 'pino';

import { Address, assert, retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import {
  SAFE_API_BASE_RETRY_MS,
  SAFE_API_RETRIES,
  canProposeSafeTransactions,
  getSafe,
  getSafeService,
} from '../../../../utils/gnosisSafe.js';
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
    protected safe: Safe.default,
    protected safeService: SafeApiKit.default,
  ) {}

  protected static async initSafeAndService(
    chain: string,
    multiProvider: MultiProvider,
    safeAddress: Address,
    signerKey?: string,
  ): Promise<{ safe: Safe.default; safeService: SafeApiKit.default }> {
    const { gnosisSafeTransactionServiceUrl } =
      multiProvider.getChainMetadata(chain);
    assert(
      gnosisSafeTransactionServiceUrl,
      `Must set gnosisSafeTransactionServiceUrl in the Registry metadata for ${chain}`,
    );

    const safe = await getSafe(chain, multiProvider, safeAddress, signerKey);
    const safeService = await getSafeService(chain, multiProvider);
    return { safe, safeService };
  }

  static async create(
    multiProvider: MultiProvider,
    props: EV5GnosisSafeTxSubmitterProps,
  ): Promise<EV5GnosisSafeTxSubmitter> {
    const { chain, safeAddress } = props;

    const signer = multiProvider.getSigner(chain);
    const signerAddress = await signer.getAddress();
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

    const safeSignerKey =
      'privateKey' in signer
        ? (signer as { privateKey: string }).privateKey
        : undefined;
    assert(
      safeSignerKey,
      'Signer must have a private key to propose Safe transactions',
    );
    const { safe, safeService } =
      await EV5GnosisSafeTxSubmitter.initSafeAndService(
        chain,
        multiProvider,
        safeAddress,
        safeSignerKey,
      );

    return new EV5GnosisSafeTxSubmitter(
      multiProvider,
      props,
      safe,
      safeService,
    );
  }

  protected async getNextNonce(): Promise<number> {
    const nextNonce = await retryAsync(
      () => this.safeService.getNextNonce(this.props.safeAddress),
      SAFE_API_RETRIES,
      SAFE_API_BASE_RETRY_MS,
    );

    return parseInt(nextNonce);
  }

  public async createSafeTransaction(
    ...transactions: AnnotatedEV5Transaction[]
  ): Promise<SafeTransaction> {
    const nextNonce = await this.getNextNonce();
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);

    const safeTransactionData = transactions.map(
      ({ to, data, value, chainId }): MetaTransactionData => {
        assert(chainId, 'Invalid AnnotatedEV5Transaction: chainId is required');
        assert(
          chainId === submitterChainId,
          `Invalid AnnotatedEV5Transaction: Cannot submit tx for chain ID ${chainId} to submitter for chain ID ${submitterChainId}.`,
        );
        assert(
          data,
          `Invalid AnnotatedEV5Transaction: calldata is required for gnosis safe transaction on chain with ID ${submitterChainId}`,
        );
        assert(
          to,
          `Invalid AnnotatedEV5Transaction: target address is required for gnosis safe transaction on chain with ID ${submitterChainId}`,
        );
        assert(
          typeof to === 'string',
          'Invalid AnnotatedEV5Transaction: target address must be a string',
        );
        return { to, data, value: value?.toString() ?? '0' };
      },
    );

    const isMultiSend = transactions.length > 1;
    const safeTransaction = await this.safe.createTransaction({
      transactions: safeTransactionData,
      onlyCalls: isMultiSend,
      options: {
        nonce: nextNonce,
      },
    });

    return safeTransaction;
  }

  public async submit(...txs: AnnotatedEV5Transaction[]): Promise<void> {
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

    return retryAsync(
      () =>
        this.safeService.proposeTransaction({
          safeAddress: this.props.safeAddress,
          safeTransactionData: safeTransaction.data,
          safeTxHash,
          senderAddress,
          senderSignature,
        }),
      SAFE_API_RETRIES,
      SAFE_API_BASE_RETRY_MS,
    );
  }
}
