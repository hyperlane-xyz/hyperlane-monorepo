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
import { AnnotatedEvmTransaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EvmTxSubmitterInterface } from './EvmTxSubmitterInterface.js';
import { EvmGnosisSafeTxSubmitterProps } from './types.js';

export class EvmGnosisSafeTxSubmitter implements EvmTxSubmitterInterface {
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_SAFE;

  protected readonly logger: Logger = rootLogger.child({
    module: 'gnosis-safe-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly props: EvmGnosisSafeTxSubmitterProps,
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

  /**
   * Extracts a private key from a signer, unwrapping wrappers like ethers NonceManager.
   */
  protected static getSignerPrivateKey(signer: any): string | undefined {
    let current: any = signer;
    const visited = new Set<any>();

    while (current && !visited.has(current)) {
      visited.add(current);

      if (
        'privateKey' in current &&
        typeof current.privateKey === 'string' &&
        current.privateKey.length > 0
      ) {
        return current.privateKey;
      }

      // ethers v6 NonceManager and similar wrappers expose an inner signer
      if ('signer' in current && current.signer) {
        current = current.signer;
        continue;
      }

      break;
    }

    return undefined;
  }

  static async create(
    multiProvider: MultiProvider,
    props: EvmGnosisSafeTxSubmitterProps,
  ): Promise<EvmGnosisSafeTxSubmitter> {
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

    const safeSignerKey = EvmGnosisSafeTxSubmitter.getSignerPrivateKey(signer);
    assert(
      safeSignerKey,
      'Signer must have a private key to propose Safe transactions',
    );
    const { safe, safeService } =
      await EvmGnosisSafeTxSubmitter.initSafeAndService(
        chain,
        multiProvider,
        safeAddress,
        safeSignerKey,
      );

    return new EvmGnosisSafeTxSubmitter(
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
    ...transactions: AnnotatedEvmTransaction[]
  ): Promise<SafeTransaction> {
    const nextNonce = await this.getNextNonce();
    const submitterChainId = this.multiProvider.getChainId(this.props.chain);

    const safeTransactionData = transactions.map(
      ({ to, data, value, chainId }): MetaTransactionData => {
        assert(chainId, 'Invalid AnnotatedEvmTransaction: chainId is required');
        assert(
          chainId === submitterChainId,
          `Invalid AnnotatedEvmTransaction: Cannot submit tx for chain ID ${chainId} to submitter for chain ID ${submitterChainId}.`,
        );
        assert(
          data,
          `Invalid AnnotatedEvmTransaction: calldata is required for gnosis safe transaction on chain with ID ${submitterChainId}`,
        );
        assert(
          to,
          `Invalid AnnotatedEvmTransaction: target address is required for gnosis safe transaction on chain with ID ${submitterChainId}`,
        );
        assert(
          typeof to === 'string',
          'Invalid AnnotatedEvmTransaction: target address must be a string',
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

  public async submit(...txs: AnnotatedEvmTransaction[]): Promise<void> {
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
