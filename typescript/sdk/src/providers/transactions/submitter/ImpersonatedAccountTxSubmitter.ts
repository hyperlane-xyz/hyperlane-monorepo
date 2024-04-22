import { TransactionReceipt } from '@ethersproject/providers';

import { impersonateAccount } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { ImpersonatedAccountHyperlaneTx } from '../ImpersonatedAccountHyperlaneTx.js';

import { TxSubmitterInterface, TxSubmitterType } from './TxSubmitter.js';

export class ImpersonatedAccountTxSubmitter
  implements TxSubmitterInterface<ImpersonatedAccountHyperlaneTx>
{
  public txSubmitterType: TxSubmitterType =
    TxSubmitterType.IMPERSONATED_ACCOUNT;

  constructor(
    public multiProvider: MultiProvider,
    public chain: ChainNameOrId,
    public userEOA: Address,
  ) {
    this.multiProvider = multiProvider;
    this.chain = chain;
    this.userEOA = userEOA;
  }

  public async sendTxs(
    hyperlaneTx: HyperlaneTx[],
  ): Promise<TransactionReceipt[]> {
    const txReceipts: TransactionReceipt[] = [];
    for (const populatedTx of hyperlaneTx) {
      const receipt = await this.sendTx(populatedTx);
      txReceipts.push(receipt);
    }
    return txReceipts;
  }

  public async sendTx(hyperlaneTx: HyperlaneTx): Promise<TransactionReceipt> {
    const signer = await impersonateAccount(this.userEOA);
    this.multiProvider.setSigner(this.chain, signer);
    return await this.multiProvider.sendTransaction(
      this.chain,
      hyperlaneTx.populatedTx,
    );
  }
}
