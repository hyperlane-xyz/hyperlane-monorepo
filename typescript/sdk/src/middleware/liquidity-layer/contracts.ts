import {
  CircleBridgeAdapter__factory,
  LiquidityLayerRouter__factory,
} from '@hyperlane-xyz/core';

import { proxiedFactories } from '../../router/types.js';

export const liquidityLayerFactories = {
  circleBridgeAdapter: new CircleBridgeAdapter__factory(),
  liquidityLayerRouter: new LiquidityLayerRouter__factory(),
  ...proxiedFactories,
};

export type LiquidityLayerFactories = typeof liquidityLayerFactories;
