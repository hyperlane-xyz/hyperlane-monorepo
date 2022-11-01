import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  MockTokenBridgeAdapter,
  MockTokenBridgeAdapter__factory,
  TokenBridgeRouter,
  TokenBridgeRouter__factory,
} from '@hyperlane-xyz/core';

import { RouterContracts, RouterFactories } from './router';

export type TokenBridgeFactories = RouterFactories<TokenBridgeRouter> & {
  circleBridgeAdapter: CircleBridgeAdapter__factory;
  mockBridgeAdapter: MockTokenBridgeAdapter__factory;
};

export const tokenBridgeFactories: TokenBridgeFactories = {
  router: new TokenBridgeRouter__factory(),
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  mockBridgeAdapter: new MockTokenBridgeAdapter__factory(),
};

export type TokenBridgeContracts = RouterContracts<TokenBridgeRouter> & {
  circleBridgeAdapter?: CircleBridgeAdapter;
  mockBridgeAdapter?: MockTokenBridgeAdapter;
};
