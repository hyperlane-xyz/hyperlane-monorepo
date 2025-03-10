import { OpenedContract } from '@ton/core';

import { JettonMinterContract } from '../wrappers/JettonMinter';
import { TokenRouter } from '../wrappers/TokenRouter';

export enum TokenStandard {
  Synthetic = 'SYNTHETIC',
  Native = 'NATIVE',
  Collateral = 'COLLATERAL',
}

export type Route = {
  jettonMinter?: OpenedContract<JettonMinterContract>;
  tokenRouter: OpenedContract<TokenRouter>;
};
