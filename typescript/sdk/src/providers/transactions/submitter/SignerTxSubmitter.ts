import { TransactionReceipt } from '@ethersproject/providers';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { SignerHyperlaneTx } from '../SignerHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class SignerTxSubmitter
  implements TxSubmitterInterface<SignerHyperlaneTx>
{
  public txSubmitterType: TxSubmitterType = TxSubmitterType.SIGNER;

  constructor(
    public multiProvider: MultiProvider,
    public chain: ChainNameOrId,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
  }

  public async sendTxs(
    hyperlaneTxs: SignerHyperlaneTx[],
  ): Promise<TransactionReceipt[]> {
    const txReceipts: TransactionReceipt[] = [];
    for (const hyperlaneTx of hyperlaneTxs) {
      const receipt = await this.sendTx(hyperlaneTx);
      txReceipts.push(receipt);
    }
    return txReceipts;
  }

  public async sendTx(
    hyperlaneTx: SignerHyperlaneTx,
  ): Promise<TransactionReceipt> {
    return this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );
  }
}
