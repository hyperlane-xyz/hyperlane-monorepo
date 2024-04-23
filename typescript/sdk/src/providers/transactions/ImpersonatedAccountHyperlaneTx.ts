import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type ImpersonatedAccountTxProps = {
  populatedTx: PopulatedTransaction;
};

export class ImpersonatedAccountHyperlaneTx
  extends HyperlaneTx
  implements ImpersonatedAccountTxProps
{
  constructor(public readonly populatedTx: PopulatedTransaction) {
    super();
    this.populatedTx = populatedTx;
  }
}
