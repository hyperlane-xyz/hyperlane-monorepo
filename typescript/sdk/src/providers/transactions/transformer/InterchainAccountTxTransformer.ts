import { PopulatedTransaction } from 'ethers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { InterchainAccountHyperlaneTx } from '../InterchainAccountHyperlaneTx.js';

import { TxTransformerInterface, TxTransformerType } from './TxTransformer.js';

export class InterchainAccountTxTransformer
  implements TxTransformerInterface<InterchainAccountHyperlaneTx>
{
  constructor(
    public readonly txTransformerType: TxTransformerType = TxTransformerType.ICA,
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  // NOTE: We will not pass every field here– structure likely to change
  public async transformTxs(
    populatedTxs: PopulatedTransaction[],
  ): Promise<InterchainAccountHyperlaneTx[]> {
    const txs: InterchainAccountHyperlaneTx[] = [];
    for (const populatedTx of populatedTxs) {
      const tx = await this.transformTx(populatedTx);
      txs.push(tx);
    }
    return txs;
  }

  public async transformTx(
    populatedTx: PopulatedTransaction,
  ): Promise<InterchainAccountHyperlaneTx> {
    return new InterchainAccountHyperlaneTx(populatedTx);
  }
}
