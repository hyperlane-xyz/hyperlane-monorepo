import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../../types.js';

export interface EV5GnosisSafeTxSubmitterProps {
  chain: ChainName;
  safeAddress: Address;
}

export interface EV5ImpersonatedAccountTxSubmitterProps {
  chain: ChainName;
  userAddress: Address;
}
