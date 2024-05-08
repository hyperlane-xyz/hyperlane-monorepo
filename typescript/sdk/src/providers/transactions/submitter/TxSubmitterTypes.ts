import { Address } from '@hyperlane-xyz/utils';

export enum TxSubmitterType {
  JSON_RPC = 'JSON RPC',
  IMPERSONATED_ACCOUNT = 'Impersonated Account',
  GNOSIS_SAFE = 'Gnosis Safe',
}

export interface EV5GnosisSafeTxSubmitterProps {
  safeAddress: Address;
}

export interface EV5ImpersonatedAccountTxSubmitterProps {
  address: Address;
}
