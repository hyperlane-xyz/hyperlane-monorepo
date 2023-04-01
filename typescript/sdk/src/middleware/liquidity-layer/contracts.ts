import {
  CircleBridgeAdapter,
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter,
  LiquidityLayerRouter__factory,
  PortalAdapter,
  PortalAdapter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { ProxiedContract } from '../../proxy';
import { ProxiedContracts, ProxiedFactories } from '../../router/types';

export type LiquidityLayerFactories = ProxiedFactories & {
  liquidityLayerRouter: LiquidityLayerRouter__factory;
  circleBridgeAdapter: CircleBridgeAdapter__factory;
  portalAdapter: PortalAdapter__factory;
};

export const liquidityLayerFactories: LiquidityLayerFactories = {
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  portalAdapter: new PortalAdapter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  liquidityLayerRouter: new LiquidityLayerRouter__factory(),
};

export type LiquidityLayerContracts = ProxiedContracts & {
  liquidityLayerRouter: ProxiedContract<LiquidityLayerRouter>;
  circleBridgeAdapter?: CircleBridgeAdapter;
  portalAdapter?: PortalAdapter;
};
