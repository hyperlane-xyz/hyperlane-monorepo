import { RouterContracts, RouterFactories } from '@hyperlane-xyz/sdk';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
} from '../types';

export type InterchainAccountFactories =
  RouterFactories<InterchainAccountRouter>;

export const interchainAccountFactories: InterchainAccountFactories = {
  router: new InterchainAccountRouter__factory(),
};

export type InterchainAccountContracts =
  RouterContracts<InterchainAccountRouter>;
