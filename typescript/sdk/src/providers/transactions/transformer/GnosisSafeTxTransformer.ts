import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  GnosisSafeHyperlaneTx,
  GnosisSafeTxProps,
} from '../GnosisSafeHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class GnosisSafeTxTransformer
  implements TxTransformerInterface<GnosisSafeHyperlaneTx>
{
  constructor(
    public readonly txTransformerType: TxTransformerType = TxTransformerType.GNOSIS_SAFE,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  // NOTE: We will not pass every field here– structure likely to change
  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
    {
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
      origin,
    }: GnosisSafeTxProps,
  ): Promise<GnosisSafeHyperlaneTx[]> {
    const txs: GnosisSafeHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx, {
        safeAddress,
        safeTransactionData,
        safeTxHash,
        senderAddress,
        senderSignature,
        origin,
      });
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
    {
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
      origin,
    }: GnosisSafeTxProps,
  ): Promise<GnosisSafeHyperlaneTx> {
    return new GnosisSafeHyperlaneTx(
      populatedTx,
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
      origin,
    );
  }
}
