import {
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter__factory,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import {
  CircleBridgeAdapter__artifact,
  LiquidityLayerRouter__artifact,
  PortalAdapter__artifact,
} from '@hyperlane-xyz/core/artifacts';

import {
  proxiedFactories,
  proxiedFactoriesArtifacts,
} from '../../router/types.js';

export const liquidityLayerFactories = {
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  portalAdapter: new PortalAdapter__factory(),
  liquidityLayerRouter: new LiquidityLayerRouter__factory(),
  ...proxiedFactories,
};
export const liquidityLayerFactoriesArtifacts = {
  circleBridgeAdapter: CircleBridgeAdapter__artifact,
  portalAdapter: PortalAdapter__artifact,
  liquidityLayerRouter: LiquidityLayerRouter__artifact,
  ...proxiedFactoriesArtifacts,
};

export type LiquidityLayerFactories = typeof liquidityLayerFactories;
