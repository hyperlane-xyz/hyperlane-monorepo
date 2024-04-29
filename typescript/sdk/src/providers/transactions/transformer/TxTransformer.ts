import { TypedTransaction } from '../../ProviderType.js';

import { TxTransformerType } from './TxTransformerTypes.js';

export interface TxTransformerInterface<TX extends TypedTransaction> {
  /**
   * Defines the type of tx transformer.
   */
  txTransformerType: TxTransformerType;

  /**
   * Should transform all transactions of type TX into transactions of type TX.
   * @param txs The array of transactions to transform
   */
  transformTxs(txs: TX[]): Promise<TX[]>;

  /**
   * Should transform a transaction of type TX into a transaction of type TX.
   * @param tx The transaction to transform
   */
  transformTx?(tx: TX): Promise<TX>;
}
