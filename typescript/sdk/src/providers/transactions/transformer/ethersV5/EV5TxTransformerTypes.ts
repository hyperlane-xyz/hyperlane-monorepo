import { InterchainAccount } from '../../../../middleware/account/InterchainAccount.js';
import { AccountConfig } from '../../../../middleware/account/types.js';
import { ChainName } from '../../../../types.js';

export interface EV5InterchainAccountTxTransformerProps {
  chain: ChainName;
  interchainAccount: InterchainAccount;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}
