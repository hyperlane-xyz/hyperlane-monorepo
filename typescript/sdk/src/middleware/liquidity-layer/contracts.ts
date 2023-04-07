import {
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter__factory,
  PortalAdapter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

export const liquidityLayerFactories = {
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  portalAdapter: new PortalAdapter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  liquidityLayerRouter: new LiquidityLayerRouter__factory(),
};

export type LiquidityLayerFactories = typeof liquidityLayerFactories;
