import { ethers } from 'ethers';

import { Router } from '@abacus-network/app';
import { types } from '@abacus-network/utils';

export type RouterConfig<
  RouterContract extends Router,
  RouterFactory extends ethers.ContractFactory,
> = {
  owner: types.Address;
  deployParams: Parameters<RouterFactory['deploy']>;
  initParams: Parameters<RouterContract['initialize']>;
};
