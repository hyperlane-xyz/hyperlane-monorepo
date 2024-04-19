import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from './HyperlaneTx.js';

export type SignerTxProps = {};

export class SignerHyperlaneTx extends HyperlaneTx implements SignerTxProps {
  constructor(public populatedTx: PopulatedTransaction) {
    super(populatedTx);
  }
}
