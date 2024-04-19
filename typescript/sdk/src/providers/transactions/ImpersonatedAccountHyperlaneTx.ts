import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type ImpersonatedAccountTxProps = {};

export class ImpersonatedAccountHyperlaneTx
  extends HyperlaneTx
  implements ImpersonatedAccountTxProps
{
  constructor(public populatedTx: PopulatedTransaction) {
    super(populatedTx);
  }
}
