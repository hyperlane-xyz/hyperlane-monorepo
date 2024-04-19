import { PopulatedTransaction } from 'ethers';

// TOOD: May require additional fields
type HyperlaneTxProps = {
  populatedTx: PopulatedTransaction;
};

export class HyperlaneTx implements HyperlaneTxProps {
  constructor(public populatedTx: PopulatedTransaction) {
    this.populatedTx = populatedTx;
  }
}
