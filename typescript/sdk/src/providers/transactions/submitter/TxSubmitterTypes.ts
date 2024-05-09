import { Address } from '@hyperlane-xyz/utils';

import { ChainName } from '../../../types.js';

export enum TxSubmitterType {
  JSON_RPC = 'JSON RPC',
  IMPERSONATED_ACCOUNT = 'Impersonated Account',
  GNOSIS_SAFE = 'Gnosis Safe',
}

export interface EV5GnosisSafeTxSubmitterProps {
  chain: ChainName;
  safeAddress: Address;
}

export interface EV5ImpersonatedAccountTxSubmitterProps {
  chain: ChainName;
  address: Address;
}
