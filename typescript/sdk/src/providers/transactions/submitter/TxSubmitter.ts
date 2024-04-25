import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import { HyperlaneTx } from '../HyperlaneTx.js';
import { HyperlaneTxReceipt } from '../HyperlaneTxReceipt.js';

import { TxSubmitterType } from './TxSubmitterTypes.js';

export interface TxSubmitterInterface<
  HTX extends HyperlaneTx,
  HTR extends HyperlaneTxReceipt,
> {
  /**
   * Defines the type of tx submitter.
   */
  txSubmitterType: TxSubmitterType;
  multiProvider: MultiProvider;
  chain: ChainName;
  /**
   * Should execute all hyperlane txs and return their tx receipts.
   * @param hyperlaneTxs The array of hyperlane txs to execute
   */
  submitTxs(hyperlaneTxs: HTX[]): Promise<HTR[]>;
  /**
   * Should execute a hyperlane transaction and return its tx receipt.
   * @param hyperlaneTx The hyperlane transaction to execute
   */
  submitTx(hyperlaneTx: HTX): Promise<HTR>;
}
