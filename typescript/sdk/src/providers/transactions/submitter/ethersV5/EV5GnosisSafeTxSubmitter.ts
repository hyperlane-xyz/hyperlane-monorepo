import SafeApiKit from '@safe-global/api-kit';
import Safe, { generateTypedData } from '@safe-global/protocol-kit';
import { MetaTransactionData, SafeTransaction } from '@safe-global/types-kit';
import { Signer } from 'ethers';
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

    const { safe, safeService } =
      await EV5GnosisSafeTxSubmitter.initSafeAndService(
        chain,
        multiProvider,
        safeAddress,
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
    const signer = this.multiProvider.getSigner(this.props.chain);
    const senderSignature = await signSafeTransactionWithSigner(
      this.safe,
      safeTransaction,
      signer,
    );

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

export async function signSafeTransactionWithSigner(
  safe: Pick<Safe.default, 'getAddress' | 'getContractVersion' | 'getChainId'>,
  safeTransaction: SafeTransaction,
  signer: Signer,
): Promise<string> {
  assert(
    '_signTypedData' in signer && typeof signer._signTypedData === 'function',
    'Signer must support EIP-712 typed-data signing to propose Safe transactions',
  );

  const typedData = generateTypedData({
    safeAddress: await safe.getAddress(),
    safeVersion: safe.getContractVersion(),
    chainId: await safe.getChainId(),
    data: safeTransaction.data,
  });
  assert(
    typedData.primaryType === 'SafeTx',
    'Expected Safe transaction typed data',
  );

  return signer._signTypedData(
    typedData.domain,
    { SafeTx: typedData.types.SafeTx },
    typedData.message,
  );
}
