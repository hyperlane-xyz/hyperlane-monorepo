import { ChainName } from '../../../types.js';
import { MultiProvider } from '../../MultiProvider.js';
import {
  TypedTransaction,
  TypedTransactionReceipt,
} from '../../ProviderType.js';

import { TxSubmitterType } from './TxSubmitterTypes.js';

export interface TxSubmitterInterface<
  TX extends TypedTransaction,
  TR extends TypedTransactionReceipt,
> {
  /**
   * Defines the type of tx submitter.
   */
  txSubmitterType: TxSubmitterType;
  multiProvider: MultiProvider;
  chain: ChainName;
  /**
   * Should execute all transactions and return their receipts.
   * @param txs The array of transactions to execute
   */
  submit(...txs: TX[]): Promise<TR[] | void>;
}
