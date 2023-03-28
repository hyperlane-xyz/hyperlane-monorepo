import {
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import {
  ProxiedRouterContracts,
  ProxiedRouterFactories,
} from '../../router/types';

export type InterchainQueryFactories =
  ProxiedRouterFactories<InterchainQueryRouter>;

export const interchainQueryFactories: InterchainQueryFactories = {
  router: new InterchainQueryRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  interchainQueryRouter: new InterchainQueryRouter__factory(),
};

export type InterchainQueryContracts =
  ProxiedRouterContracts<InterchainQueryRouter>;
