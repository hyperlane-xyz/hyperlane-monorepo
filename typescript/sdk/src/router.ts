import type { ethers } from 'ethers';

import { Router } from '@hyperlane-xyz/app';
import type { types } from '@hyperlane-xyz/utils';

import { AbacusContracts, AbacusFactories } from './contracts';

export type RouterContracts<RouterContract extends Router = Router> =
  AbacusContracts & {
    router: RouterContract;
  };

type RouterFactory<RouterContract extends Router = Router> =
  ethers.ContractFactory & {
    deploy: (...args: any[]) => Promise<RouterContract>;
  };

export type RouterFactories<RouterContract extends Router = Router> =
  AbacusFactories & {
    router: RouterFactory<RouterContract>;
  };

export type ConnectionClientConfig = {
  abacusConnectionManager: types.Address;
  interchainGasPaymaster: types.Address;
};

export { Router } from '@hyperlane-xyz/app';
