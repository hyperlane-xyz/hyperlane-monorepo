import { PopulatedTransaction } from 'ethers';

import { HyperlaneTx } from '../HyperlaneTx.js';

export enum TxTransformerType {
  SIGNER /* Private key transformer */,
  IMPERSONATED_ACCOUNT /* Impersonated account transformer */,
  GNOSIS_SAFE /* Gnosis Safe transformer */,
  ICA /* Interchain Account transformer */,
}

export interface TxTransformerInterface<HTX extends HyperlaneTx> {
  /**
   * Defines the type of tx transformer
   */
  txTransformerType: TxTransformerType;

  /**
   * Should transform all populated txs into HyperlaneTransactions
   * @param populatedTxs The array of populated txs to transform
   */
  transformTxs(
    populatedTxs: PopulatedTransaction[] /* NOTE: Will eventually extend for SL/CW via https://tinyurl.com/yx4bxfbu */,
    props?: any,
  ): Promise<HTX[]>;

  /**
   * Should transform a populated tx into a HyperlaneTransaction
   * @param populatedTx The populated tx to transform
   */
  transformTx(populatedTx: PopulatedTransaction, props?: any): Promise<HTX>;
}
