import { Router, Router__factory } from '@abacus-network/app';
import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
} from '@abacus-network/core';

import { AbacusContracts, AbacusFactories } from './contracts';

export type RouterContracts<RouterContract extends Router = Router> =
  AbacusContracts & {
    router: RouterContract;
    abacusConnectionManager: AbacusConnectionManager;
  };

export type RouterFactories<
  RouterFactory extends Router__factory = Router__factory,
> = AbacusFactories & {
  router: RouterFactory;
  abacusConnectionManager: AbacusConnectionManager__factory;
};
