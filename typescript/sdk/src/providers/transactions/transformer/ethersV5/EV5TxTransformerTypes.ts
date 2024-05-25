import { GetCallRemoteSettings } from '../../../../middleware/account/InterchainAccount.js';

export interface EV5InterchainAccountTxTransformerProps
  extends Omit<GetCallRemoteSettings, 'destination' | 'innerCalls'> {}
