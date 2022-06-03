import { Router, Router__factory } from '@abacus-network/app';

import { AbacusContracts, AbacusFactories } from './contracts';
import { ProxiedContract } from './proxy';

export type RouterContracts<RouterContract extends Router = Router> =
  AbacusContracts & {
    router: RouterContract | ProxiedContract<RouterContract, any>;
  };

export type RouterFactories<
  RouterFactory extends Router__factory = Router__factory,
> = AbacusFactories & {
  router: RouterFactory;
};

export { Router } from '@abacus-network/app';
