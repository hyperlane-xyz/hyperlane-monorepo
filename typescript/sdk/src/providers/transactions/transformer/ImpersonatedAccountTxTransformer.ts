import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { ImpersonatedAccountHyperlaneTx } from '../ImpersonatedAccountHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class ImpersonatedAccountTxTransformer
  implements TxTransformerInterface<ImpersonatedAccountHyperlaneTx>
{
  constructor(
    public readonly txTransformerType: TxTransformerType = TxTransformerType.IMPERSONATED_ACCOUNT,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  // NOTE: We will not pass every field here– structure likely to change
  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
  ): Promise<ImpersonatedAccountHyperlaneTx[]> {
    const txs: ImpersonatedAccountHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<ImpersonatedAccountHyperlaneTx> {
    return new ImpersonatedAccountHyperlaneTx(populatedTx);
  }
}
