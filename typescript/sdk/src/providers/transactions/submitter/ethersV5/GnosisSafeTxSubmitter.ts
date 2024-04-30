import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthSafeSignature } from '@safe-global/protocol-kit';
import {
  MetaTransactionData,
  SafeTransactionData,
} from '@safe-global/safe-core-sdk-types';
import assert from 'assert';
import { Logger } from 'pino';

import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';
import { getSafe, getSafeService } from '../../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../../MultiProvider.js';
import {
  EthersV5Transaction,
  EthersV5TransactionReceipt,
} from '../../../ProviderType.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

interface GnosisSafeTxSubmitterProps {
  safeAddress: Address;
  signerAddress?: Address;
}

export class GnosisSafeTxSubmitter
  implements
    TxSubmitterInterface<EthersV5Transaction, EthersV5TransactionReceipt>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_SAFE;

  protected readonly logger: Logger = rootLogger.child({
    module: 'gnosis-safe-submitter',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: GnosisSafeTxSubmitterProps,
  ) {}

  public async submit(...txs: EthersV5Transaction[]): Promise<void> {
    const safe: Safe.default = await getSafe(
      this.chain,
      this.multiProvider,
      this.props.safeAddress,
    );
    const safeService: SafeApiKit.default = getSafeService(
      this.chain,
      this.multiProvider,
    );
    const nextNonce: number = await safeService.getNextNonce(
      this.props.safeAddress,
    );
    const safeTransactionBatch: MetaTransactionData[] = txs.map(
      ({ transaction }: EthersV5Transaction) => {
        const { to, data, value } = transaction;
        assert(
          to && data,
          'Invalid EthersV5Transaction: Missing required field to or data.',
        );
        return { to, data, value: value?.toString() ?? '0' };
      },
    );
    const safeTransaction = await safe.createTransaction({
      safeTransactionData: safeTransactionBatch,
      options: { nonce: nextNonce },
    });
    const safeTransactionData: SafeTransactionData = safeTransaction.data;
    const safeTxHash: string = await safe.getTransactionHash(safeTransaction);
    let senderAddress: Address | undefined = this.props.signerAddress;
    if (!senderAddress) {
      senderAddress = await this.multiProvider.getSignerAddress(this.chain);
    }
    const safeSignature: EthSafeSignature = await safe.signTransactionHash(
      safeTxHash,
    );
    const senderSignature: string = safeSignature.data;

    this.logger.debug(
      `Submitting transaction proposal to ${this.props.safeAddress} on ${this.chain}: ${safeTxHash}`,
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
