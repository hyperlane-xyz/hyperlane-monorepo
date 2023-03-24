import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { ProxiedRouterContracts, RouterFactories } from '../../router/types';

export type InterchainAccountFactories =
  RouterFactories<InterchainAccountRouter>;

export const interchainAccountFactories: InterchainAccountFactories = {
  router: new InterchainAccountRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainAccountContracts =
  ProxiedRouterContracts<InterchainAccountRouter>;
