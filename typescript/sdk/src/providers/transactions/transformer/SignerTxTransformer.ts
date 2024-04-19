import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { SignerHyperlaneTx } from '../SignerHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class SignerTxTransformer
  implements TxTransformerInterface<SignerHyperlaneTx>
{
  constructor(
    public readonly txTransformerType: TxTransformerType = TxTransformerType.SIGNER,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  // NOTE: We will not pass every field here– structure likely to change
  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
  ): Promise<SignerHyperlaneTx[]> {
    const txs: SignerHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<SignerHyperlaneTx> {
    return new SignerHyperlaneTx(populatedTx);
  }
}
