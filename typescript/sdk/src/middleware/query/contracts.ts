import {
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';

import { ProxiedRouterContracts, RouterFactories } from '../../router/types';

export type InterchainQueryFactories = RouterFactories<InterchainQueryRouter>;

export const interchainQueryFactories: InterchainQueryFactories = {
  router: new InterchainQueryRouter__factory(),
};

export type InterchainQueryContracts =
  ProxiedRouterContracts<InterchainQueryRouter>;
