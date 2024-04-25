import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthSafeSignature } from '@safe-global/protocol-kit';
import EthSafeTransaction from '@safe-global/protocol-kit/dist/src/utils/transactions/SafeTransaction.js';
import assert from 'assert';
import { Logger } from 'pino';

import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';
import { getSafe, getSafeService } from '../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../MultiProvider.js';
import { SafeTransactionData } from '../GnosisSafeHyperlaneTx.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';

import { TxSubmitterInterface } from './TxSubmitter.js';
import {
  GnosisSafeTxSubmitterProps,
  TxSubmitterType,
} from './TxSubmitterTypes.js';

export class GnosisSafeTxSubmitter<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> implements TxSubmitterInterface<HTX, HTR>
{
  public readonly txSubmitterType: TxSubmitterType =
    TxSubmitterType.GNOSIS_SAFE;

  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly props: GnosisSafeTxSubmitterProps,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
    this.props = props;
  }

  public async submitTxs(hyperlaneTxs: HTX[]): Promise<HTR[]> {
    const hyperlaneReceipts: HTR[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.submitTx(hyperlaneTx);
      hyperlaneReceipts.push(receipt);
    }
    return hyperlaneReceipts;
  }

  public async submitTx(hyperlaneTx: HTX): Promise<HTR> {
    const to = hyperlaneTx.to;
    const data = hyperlaneTx.data;

    assert(to && data, 'Invalid HyperlaneTx: Missing required metadata.');

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
    const safeTransaction: EthSafeTransaction.default =
      await safe.createTransaction({
        safeTransactionData: { to, value: '0', data },
        options: { nonce: nextNonce },
      });
    const safeTransactionData: SafeTransactionData = safeTransaction.data;
    const safeTxHash: string = await safe.getTransactionHash(safeTransaction);
    const senderAddress: Address = await this.multiProvider.getSignerAddress(
      this.chain,
    );
    const safeSignature: EthSafeSignature = await safe.signTransactionHash(
      safeTxHash,
    );
    const senderSignature: string = safeSignature.data;

    this.logger.debug(
      `Submitting transaction proposal to ${this.props.safeAddress} on ${this.chain}: ${safeTxHash}`,
    );

    return (await safeService.proposeTransaction({
      safeAddress: this.props.safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
    })) as HTR;
  }
}
