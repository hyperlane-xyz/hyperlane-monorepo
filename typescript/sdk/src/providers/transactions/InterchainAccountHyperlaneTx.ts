import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type InterchainAccountTxProps = {
  populatedTx: PopulatedTransaction;
};

export class InterchainAccountHyperlaneTx
  extends HyperlaneTx
  implements InterchainAccountTxProps
{
  constructor(public readonly populatedTx: PopulatedTransaction) {
    super();
    this.populatedTx = populatedTx;
  }
}
