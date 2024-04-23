import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type SignerTxProps = {
  populatedTx: PopulatedTransaction;
};

export class SignerHyperlaneTx extends HyperlaneTx implements SignerTxProps {
  constructor(public readonly populatedTx: PopulatedTransaction) {
    super();
    this.populatedTx = populatedTx;
  }
}
