import { type ProtocolType } from '@hyperlane-xyz/utils';

import { type MultiProvider } from '../../../MultiProvider.js';
import { type TxSubmitterInterface } from '../TxSubmitterInterface.js';

export interface EV5TxSubmitterInterface
  extends TxSubmitterInterface<ProtocolType.Ethereum> {
  /**
   * The EV5 multi-provider to use for transaction submission.
   */
  multiProvider: MultiProvider;
}
