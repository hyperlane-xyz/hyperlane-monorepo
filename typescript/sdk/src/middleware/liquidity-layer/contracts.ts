import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  LiquidityLayerRouter__factory,
  PortalAdapter,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';

import { ProxiedRouterContracts, RouterFactories } from '../../router';

export type LiquidityLayerFactories = RouterFactories<LiquidityLayerRouter> & {
  circleBridgeAdapter: CircleBridgeAdapter__factory;
  portalAdapter: PortalAdapter__factory;
};

export const liquidityLayerFactories: LiquidityLayerFactories = {
  router: new LiquidityLayerRouter__factory(),
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  portalAdapter: new PortalAdapter__factory(),
};

export type LiquidityLayerContracts =
  ProxiedRouterContracts<LiquidityLayerRouter> & {
    circleBridgeAdapter?: CircleBridgeAdapter;
    portalAdapter?: PortalAdapter;
  };
