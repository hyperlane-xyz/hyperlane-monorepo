import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../../MultiProvider.js';
import { TxSubmitterInterface } from '../TxSubmitterInterface.js';

export interface EvmTxSubmitterInterface extends TxSubmitterInterface<ProtocolType.Ethereum> {
  /**
   * The Evm multi-provider to use for transaction submission.
   */
  multiProvider: MultiProvider;
}
