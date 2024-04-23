import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthSafeSignature } from '@safe-global/protocol-kit';
import EthSafeTransaction from '@safe-global/protocol-kit/dist/src/utils/transactions/SafeTransaction.js';
import { PopulatedTransaction } from 'ethers';
import { Logger } from 'pino';

import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';
import { getSafe, getSafeService } from '../../../utils/gnosisSafe.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  GnosisSafeHyperlaneTx,
  GnosisSafeHyperlaneTxProps,
  GnosisSafeTxProps,
  SafeTransactionData,
} from '../GnosisSafeHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class GnosisSafeTxTransformer
  implements TxTransformerInterface<GnosisSafeHyperlaneTx>
{
  public readonly txTransformerType: TxTransformerType =
    TxTransformerType.GNOSIS_SAFE;
  protected readonly logger: Logger = rootLogger.child({
    module: 'transactions',
  });

  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
    { safeAddress }: GnosisSafeTxProps,
  ): Promise<GnosisSafeHyperlaneTx[]> {
    const txs: GnosisSafeHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx, {
        safeAddress,
      });
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
    { safeAddress }: GnosisSafeTxProps,
  ): Promise<GnosisSafeHyperlaneTx> {
    const to = populatedTx.to,
      data = populatedTx.data;

    if (!to || !data)
      throw new Error(
        'Invalid PopulatedTransaction: Missing required metadata.',
      );

    const safe: Safe.default = await getSafe(
      this.chain,
      this.multiProvider,
      safeAddress,
    );
    const safeService: SafeApiKit.default = getSafeService(
      this.chain,
      this.multiProvider,
    );
    const nextNonce: number = await safeService.getNextNonce(safeAddress);
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

    const gnosisSafeHyperlaneTxProps: GnosisSafeHyperlaneTxProps = {
      chain: this.chain,
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
      safeService,
    };

    this.logger.debug(
      'Transforming to GnosisSafeHyperlaneTx:',
      gnosisSafeHyperlaneTxProps,
      '...',
    );

    return new GnosisSafeHyperlaneTx(gnosisSafeHyperlaneTxProps);
  }
}
