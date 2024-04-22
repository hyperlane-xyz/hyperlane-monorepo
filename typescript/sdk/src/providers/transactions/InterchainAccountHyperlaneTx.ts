import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type InterchainAccountTxProps = {};

export class InterchainAccountHyperlaneTx
  extends HyperlaneTx
  implements InterchainAccountTxProps
{
  constructor(public populatedTx: PopulatedTransaction) {
    super(populatedTx);
  }
}
