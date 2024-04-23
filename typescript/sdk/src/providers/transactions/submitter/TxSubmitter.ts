import { HyperlaneTx } from '../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';

export enum TxSubmitterType {
  SIGNER /* Private key submitter */,
  IMPERSONATED_ACCOUNT /* Impersonated account submitter */,
  GNOSIS_SAFE /* Gnosis Safe submitter */,
  // ICA /* Interchain Account submitter */, // TODO: Grouped into Gnosis ?
  // RETRY /* Retry submitter */ // TODO: Discuss
}

export interface TxSubmitterInterface<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> {
  /**
   * Defines the type of tx submitter
   */
  txSubmitterType: TxSubmitterType;
  /**
   * Should execute all hyperlane txs and return their tx receipts
   * @param hyperlaneTxs The array of hyperlane txs to execute
   */
  submitTxs(hyperlaneTxs: HTX[]): Promise<HTR[]>;
  /**
   * Should execute a hyperlane tx and return its tx receipt
   * @param hyperlaneTx The hyperlane tx to execute
   */
  submitTx(hyperlaneTx: HTX): Promise<HTR>;
}
