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
  transform(...txs: TX[]): Promise<TX[]>;
}
