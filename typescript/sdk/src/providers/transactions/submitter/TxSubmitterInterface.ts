import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ProtocolTypedProvider,
  ProtocolTypedReceipt,
  ProtocolTypedTransaction,
} from '../../ProviderType.js';

import { TxSubmitterType } from './TxSubmitterTypes.js';

export interface TxSubmitterInterface<TProtocol extends ProtocolType> {
  /**
   * Defines the type of tx submitter.
   */
  txSubmitterType: TxSubmitterType;
  /**
   * The provider to use for transaction submission.
   */
  provider?: ProtocolTypedProvider<TProtocol>['provider'];
  /**
   * Should execute all transactions and return their receipts.
   * @param txs The array of transactions to execute
   */
  submit(
    ...txs: ProtocolTypedTransaction<TProtocol>['transaction'][]
  ): Promise<ProtocolTypedReceipt<TProtocol>['receipt'][] | void>;
}
