import { PopulatedTransaction } from 'ethers';

// TODO: May require additional fields
type HyperlaneTxProps = {
  populatedTx: PopulatedTransaction;
};

export class HyperlaneTx implements HyperlaneTxProps {
  constructor(public populatedTx: PopulatedTransaction) {
    this.populatedTx = populatedTx;
  }
}
