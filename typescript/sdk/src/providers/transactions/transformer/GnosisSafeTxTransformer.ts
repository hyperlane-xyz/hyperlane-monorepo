import { Provider } from '@ethersproject/providers';
import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
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
    public readonly provider: Provider,
    public readonly chain: ChainNameOrId,
  ) {
    this.provider = provider;
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
      populatedTx, // TODO: Remove from actual tx since we only submit this offchain (use anything we can to populate gnosis type fields)
      safeAddress,
      safeTransactionData,
      safeTxHash,
      senderAddress,
      senderSignature,
      origin,
    );
  }
}
