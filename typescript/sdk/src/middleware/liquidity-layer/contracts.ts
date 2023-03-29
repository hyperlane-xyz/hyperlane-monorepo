import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  LiquidityLayerRouter__factory,
  PortalAdapter,
  PortalAdapter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import {
  ProxiedRouterContracts,
  ProxiedRouterFactories,
} from '../../router/types';

export type LiquidityLayerFactories =
  ProxiedRouterFactories<LiquidityLayerRouter> & {
    circleBridgeAdapter: CircleBridgeAdapter__factory;
    portalAdapter: PortalAdapter__factory;
  };

export const liquidityLayerFactories: LiquidityLayerFactories = {
  router: new LiquidityLayerRouter__factory(),
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  portalAdapter: new PortalAdapter__factory(),
  // TODO: where to put these?
  proxyAdmin: new ProxyAdmin__factory(),
  liquidityLayerRouter: new LiquidityLayerRouter__factory(),
};

export type LiquidityLayerContracts =
  ProxiedRouterContracts<LiquidityLayerRouter> & {
    circleBridgeAdapter?: CircleBridgeAdapter;
    portalAdapter?: PortalAdapter;
  };
