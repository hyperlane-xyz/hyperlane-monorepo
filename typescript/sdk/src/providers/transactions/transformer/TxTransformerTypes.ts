import { InterchainAccount } from '../../../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../../../middleware/account/types.js';
import { ChainName } from '../../../types.js';

export enum TxTransformerType {
  ICA = 'Interchain Account',
}

export interface EV5InterchainAccountTxTransformerProps {
  chain: ChainName;
  interchainAccount: InterchainAccount;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}
