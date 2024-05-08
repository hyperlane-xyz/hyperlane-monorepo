import { InterchainAccount } from '../../../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../../../middleware/account/types.js';

export enum TxTransformerType {
  ICA = 'Interchain Account',
}

export interface EV5InterchainAccountTxTransformerProps {
  interchainAccount: InterchainAccount;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}
