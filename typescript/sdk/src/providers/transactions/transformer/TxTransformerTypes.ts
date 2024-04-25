import { HyperlaneContractsMap } from '../../../contracts/types.js';
import { InterchainAccountFactories } from '../../../middleware/account/contracts.js';
import { AccountConfig } from '../../../middleware/account/types.js';

export enum TxTransformerType {
  ICA = 'Interchain Account',
}

export interface InterchainAccountTxTransformerProps {
  contractsMap: HyperlaneContractsMap<InterchainAccountFactories>;
  accountConfig: AccountConfig;
  hookMetadata?: string;
}
