import { Address } from '@hyperlane-xyz/utils';

export enum TxSubmitterType {
  SIGNER = 'Signer',
  IMPERSONATED_ACCOUNT = 'Impersonated Account',
  GNOSIS_SAFE = 'Gnosis Safe',
}

export interface GnosisSafeTxSubmitterProps {
  safeAddress: Address;
}

export interface ImpersonatedAccountTxSubmitterProps {
  userEOA: Address;
}
