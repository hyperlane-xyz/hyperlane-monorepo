import { Annotated, ProtocolType } from '@hyperlane-xyz/utils';

import { ProtocolTypedTransaction } from '../../ProviderType.js';

import { TxTransformerType } from './TxTransformerTypes.js';

export interface TxTransformerInterface<TProtocol extends ProtocolType> {
  /**
   * Defines the type of tx transformer.
   */
  txTransformerType: TxTransformerType;
  /**
   * Should transform all transactions of type TX into transactions of type TX.
   * @param txs The array of transactions to transform
   */
  transform(
    ...txs: Annotated<ProtocolTypedTransaction<TProtocol>['transaction']>[]
  ): Promise<Annotated<ProtocolTypedTransaction<TProtocol>['transaction']>[]>;
}
