import { type Annotated, type ProtocolType } from '@hyperlane-xyz/utils';

import {
  type ProtocolTypedProvider,
  type ProtocolTypedReceipt,
  type ProtocolTypedTransaction,
} from '../../ProviderType.js';

import { type TxSubmitterType } from './TxSubmitterTypes.js';

export interface TxSubmitterInterface<
  TProtocol extends ProtocolType,
  TSubmitterType extends string = TxSubmitterType,
> {
  /**
   * Defines the type of tx submitter.
   */
  txSubmitterType: TSubmitterType;
  /**
   * The provider to use for transaction submission.
   */
  provider?: ProtocolTypedProvider<TProtocol>['provider'];
  /**
   * Should execute all transactions and return their receipts.
   * @param txs The array of transactions to execute
   */
  submit(
    ...txs: Annotated<ProtocolTypedTransaction<TProtocol>['transaction']>[]
  ): Promise<
    | ProtocolTypedReceipt<TProtocol>['receipt']
    | ProtocolTypedReceipt<TProtocol>['receipt'][]
    | void
  >;
}
