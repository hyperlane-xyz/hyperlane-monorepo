import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from '../HyperlaneTx.js';
import { TxSubmitterType } from '../submitter/TxSubmitterTypes.js';

import { TxTransformerType } from './TxTransformerTypes.js';

export interface TxTransformerInterface<HTX extends HyperlaneTx> {
  /**
   * Defines the type of tx transformer.
   */
  txTransformerType: TxTransformerType;

  /**
   * Should transform all populated txs into HyperlaneTxs.
   * @param populatedTxs The array of hyperlane txs to transform
   */
  transformTxs(
    populatedTxs: PopulatedTransaction[] /* NOTE: Will eventually extend for SL/CW via https://tinyurl.com/yx4bxfbu */,
    txSubmitterType: TxSubmitterType,
  ): Promise<HTX[]>;

  /**
   * Should transform a populated transaction into a HyperlaneTx.
   * @param populatedTx The populated transaction to transform
   */
  transformTx(populatedTx: PopulatedTransaction, props?: any): Promise<HTX>;
}
